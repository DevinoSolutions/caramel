import { chat, OpenRouterError } from '@/lib/openrouter'
import crypto from 'node:crypto'
import { z } from 'zod'

export const CATEGORY_ENUM = [
    'apparel',
    'beauty',
    'books_media',
    'electronics',
    'food_grocery',
    'health_supplements',
    'home_garden',
    'jewelry_accessories',
    'office_supplies',
    'pet',
    'services_subscriptions',
    'sports_outdoors',
    'tools_hardware',
    'toys_games',
    'travel',
    'other',
] as const

export type Category = (typeof CATEGORY_ENUM)[number]

export interface CartSignals {
    domain: string
    url_path?: string
    title?: string
    meta_description?: string
    og_site_name?: string
    og_type?: string
    cart_items?: string[]
    platform_hints?: Record<string, boolean>
}

export interface Classification {
    primary: Category
    secondary?: Category
    confidence: number
    cached: boolean
}

// In-memory LRU-ish cache, capped at 2000 entries, 24h TTL.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CACHE_MAX = 2000
type CacheEntry = { expires: number; value: Omit<Classification, 'cached'> }
const cache = new Map<string, CacheEntry>()

function cacheKey(s: CartSignals): string {
    const norm = {
        d: s.domain,
        t: (s.title || '').toLowerCase().slice(0, 120),
        m: (s.meta_description || '').toLowerCase().slice(0, 160),
        i: (s.cart_items || []).map(x => x.toLowerCase().slice(0, 80)).sort(),
    }
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(norm))
        .digest('hex')
        .slice(0, 32)
}

function cacheGet(key: string): Omit<Classification, 'cached'> | null {
    const entry = cache.get(key)
    if (!entry) return null
    if (entry.expires < Date.now()) {
        cache.delete(key)
        return null
    }
    // Refresh LRU ordering
    cache.delete(key)
    cache.set(key, entry)
    return entry.value
}

function cacheSet(key: string, value: Omit<Classification, 'cached'>) {
    if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value
        if (oldest) cache.delete(oldest)
    }
    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value })
}

function buildMessages(s: CartSignals) {
    const payload = {
        domain: s.domain,
        title: s.title || '',
        meta_description: s.meta_description || '',
        site_name: s.og_site_name || '',
        cart_items: (s.cart_items || []).slice(0, 6),
    }
    const allowed = CATEGORY_ENUM.join(', ')
    return [
        {
            role: 'system' as const,
            content:
                'You classify e-commerce carts into a category so the app can show relevant coupons. ' +
                'You get a compact JSON snapshot of the shop and cart. ' +
                `Return JSON ONLY, schema: {"primary":"<one_of>","secondary":"<one_of_or_null>","confidence":0..1}. ` +
                `Allowed categories: ${allowed}. ` +
                `Use "other" only when nothing fits. Use secondary when two categories are plausibly valid (e.g. a gift store with both jewelry and apparel).`,
        },
        {
            role: 'user' as const,
            content: JSON.stringify(payload),
        },
    ]
}

// F-012 — output schema for the LLM's classification JSON, exported so the
// eval harness (apps/caramel-app/evals/) validates live results against the
// SAME contract production uses (never a re-implemented/copied check).
//
// The .transform() body is a byte-exact port of the hand-rolled validation
// it replaces (see PLAN-F-012.md — verified via a characterization-test
// pin, tests/unit/cartClassifier.parse.test.ts, that stayed green across
// the refactor): an unrecognized primary is the ONLY hard failure; unknown
// secondary / secondary===primary / out-of-range|non-numeric|missing
// confidence all self-heal (drop / coerce to 0.5) exactly as before,
// because prod is designed to degrade gracefully on those two fields.
//
// Every field is `.optional()` even though the system prompt always asks
// for all three keys — zod v4 treats a wholly ABSENT object key as a
// validation failure for a bare `z.unknown()` field (only an explicit
// `undefined` value passes), and a real LLM response can omit a key
// (e.g. no `secondary`) rather than sending it as `null`/`undefined`.
//
// `ctx.addIssue(string)` + `return z.NEVER` marks the parse as failed with
// a custom message — but a raw ZodError's `.message` is a JSON-stringified
// issues array, not that message string, so parseResponse below must catch
// it and re-throw a plain Error carrying `issues[0].message` verbatim; a
// bare `classificationSchema.parse(...)` would leak the JSON blob into
// Sentry/the 500 response body instead of `unknown primary category: X`.
export const classificationSchema = z
    .object({
        primary: z.unknown().optional(),
        secondary: z.unknown().optional(),
        confidence: z.unknown().optional(),
    })
    .transform((parsed, ctx) => {
        const obj = parsed as {
            primary?: string
            secondary?: string | null
            confidence?: number
        }
        const primary = (obj.primary || '').trim()
        if (!(CATEGORY_ENUM as readonly string[]).includes(primary)) {
            ctx.addIssue(`unknown primary category: ${primary}`)
            return z.NEVER
        }
        const secondary = obj.secondary
            ? String(obj.secondary).trim()
            : undefined
        const validSecondary =
            secondary &&
            secondary !== primary &&
            (CATEGORY_ENUM as readonly string[]).includes(secondary)
                ? (secondary as Category)
                : undefined
        const confidence =
            typeof obj.confidence === 'number' &&
            obj.confidence >= 0 &&
            obj.confidence <= 1
                ? obj.confidence
                : 0.5
        return {
            primary: primary as Category,
            secondary: validSecondary,
            confidence,
        }
    })

function parseResponse(raw: string): Omit<Classification, 'cached'> {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        const m = raw.match(/\{[\s\S]*\}/)
        if (!m) throw new Error('llm returned non-json')
        parsed = JSON.parse(m[0])
    }
    const result = classificationSchema.safeParse(parsed)
    if (!result.success) {
        throw new Error(
            result.error.issues[0]?.message ??
                'invalid classification response',
        )
    }
    return result.data
}

export async function classifyCart(
    signals: CartSignals,
): Promise<Classification> {
    const key = cacheKey(signals)
    const hit = cacheGet(key)
    if (hit) return { ...hit, cached: true }

    const messages = buildMessages(signals)
    let raw: string
    try {
        raw = await chat(messages, {
            responseFormat: 'json_object',
            // F-017: 600, not the original 120 — the default model
            // (openai/gpt-5-mini) is a REASONING model whose hidden
            // reasoning tokens count against max_tokens; at 120 nearly
            // every call spent the whole budget reasoning and truncated
            // (finish_reason "length") with content:null before emitting
            // any visible JSON -> "empty response" on ~95% of live calls.
            // Sized empirically against the eval suite (see
            // evals/SCOREBOARD.md, 2026-07-11): observed completion max
            // 316 tokens (256 reasoning + the JSON answer), so 600 is ~2x
            // headroom; measured cost is identical to a 400 cap (the
            // model stops naturally under both) and p95 latency 5965ms
            // fits timeoutMs below with margin. Change this only through
            // another eval-gated run (evals/README.md §Codify).
            maxTokens: 600,
            temperature: 0,
            timeoutMs: 7000,
        })
    } catch (e) {
        if (e instanceof OpenRouterError) throw e
        throw new OpenRouterError(`classify failed: ${(e as Error).message}`)
    }
    const value = parseResponse(raw)
    cacheSet(key, value)
    return { ...value, cached: false }
}
