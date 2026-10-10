import { chat, OpenRouterError } from '@/lib/openrouter'
import * as Sentry from '@sentry/nextjs'
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
// the refactor): a missing/blank primary is the ONLY hard failure (a
// non-blank label outside the vocabulary is degraded by parseResponse, see
// CARAMEL-T below); unknown
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
            // A NON-EMPTY label outside the vocabulary is model drift
            // (CARAMEL-T: "furniture"); parseResponse degrades it to the
            // fallback category. It is told apart from a missing/blank
            // primary (a malformed reply, still a hard failure) by the
            // `outOfVocabularyPrimary` param, so no caller matches on the
            // message text. The schema itself stays strict: the eval
            // harness's scoreSchemaValid relies on it rejecting a result
            // whose primary is not a real category.
            ctx.addIssue({
                code: 'custom',
                message: `unknown primary category: ${primary}`,
                params: primary ? { outOfVocabularyPrimary: primary } : {},
            })
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

// End index (exclusive) of the balanced `{...}` that opens at `start`, or
// -1 when the braces never close (a truncated reply). Braces inside JSON
// strings are skipped, including escaped quotes, so `{"a":"}"}` is one
// object and not a premature close.
function balancedObjectEnd(text: string, start: number): number {
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
        const ch = text[i]
        if (inString) {
            if (ch === '\\') i++
            else if (ch === '"') inString = false
            continue
        }
        if (ch === '"') inString = true
        else if (ch === '{') depth++
        else if (ch === '}') {
            depth--
            if (depth === 0) return i + 1
        }
    }
    return -1
}

// CARAMEL-G (2026-09-24/25) — the FIRST complete JSON object in the reply.
// `response_format: json_object` is a request, not a guarantee: for the
// default model (anthropic/claude-haiku-4.5) OpenRouter can route to an
// endpoint that does not support `response_format` at all, and the model
// then answered with a pretty-printed object followed by a line of
// commentary. The previous fallback, a GREEDY `/\{[\s\S]*\}/`, ran from the
// first `{` to the LAST `}` in the whole reply, so any brace in that
// trailing text dragged it into the slice and the unguarded JSON.parse threw
// a raw SyntaxError ("Unexpected non-whitespace character after JSON at
// position 77 (line 6 column 1)"). Each `{` is tried in order and the first
// balanced slice that parses wins; one that does not parse (a brace in prose
// before the answer) is skipped, never repaired or guessed at.
function firstJsonObject(raw: string): unknown {
    for (
        let start = raw.indexOf('{');
        start !== -1;
        start = raw.indexOf('{', start + 1)
    ) {
        const end = balancedObjectEnd(raw, start)
        if (end === -1) continue
        try {
            return JSON.parse(raw.slice(start, end))
        } catch {
            // Balanced but not JSON (e.g. "{the} answer") — try the next `{`.
        }
    }
    throw new Error('llm returned non-json')
}

// CARAMEL-T (2026-10-06) — the model answered with a category outside
// CATEGORY_ENUM ("furniture") and the whole request failed with a 500, so the
// shopper's cart got no coupon filtering at all. The prompt is eval-gated and
// stays as is; the RESPONSE handling degrades instead: the vocabulary's own
// fallback ('other') at a confidence low enough that no consumer mistakes it
// for a real classification. Never silent: every occurrence is a Sentry
// warning carrying the raw label, so drift in the model's vocabulary (and
// therefore a missing category or prompt gap) stays visible.
const FALLBACK_CATEGORY: Category = 'other'
const OUT_OF_VOCABULARY_CONFIDENCE = 0.2
const RAW_LABEL_LOG_MAX = 80

function degradeOutOfVocabularyPrimary(
    rawPrimary: string,
    domain: string,
): Omit<Classification, 'cached'> {
    Sentry.captureMessage(
        'classify-cart: model returned a primary category outside the vocabulary; degraded to fallback',
        {
            level: 'warning',
            tags: { surface: 'classify-cart', operation: 'unknown_primary' },
            // One issue for the whole drift class; the raw label is context.
            fingerprint: ['classify-cart', 'unknown-primary-category'],
            extra: {
                rawPrimary: rawPrimary.slice(0, RAW_LABEL_LOG_MAX),
                fallback: FALLBACK_CATEGORY,
                domain,
            },
        },
    )
    return {
        primary: FALLBACK_CATEGORY,
        secondary: undefined,
        confidence: OUT_OF_VOCABULARY_CONFIDENCE,
    }
}

function parseResponse(
    raw: string,
    domain: string,
): Omit<Classification, 'cached'> {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        parsed = firstJsonObject(raw)
    }
    const result = classificationSchema.safeParse(parsed)
    if (!result.success) {
        for (const issue of result.error.issues) {
            const label =
                issue.code === 'custom'
                    ? issue.params?.outOfVocabularyPrimary
                    : undefined
            if (typeof label === 'string') {
                return degradeOutOfVocabularyPrimary(label, domain)
            }
        }
        throw new Error(
            result.error.issues[0]?.message ??
                'invalid classification response',
        )
    }
    return result.data
}

/**
 * `admitModelCall` runs only on a cache MISS, immediately before the paid
 * model call, and may throw to refuse it (the route passes
 * classifyCartModelBudget's admitClassifyModelCall). The eval harness omits
 * it — evals must measure the model, not the budget.
 */
export async function classifyCart(
    signals: CartSignals,
    admitModelCall?: () => Promise<void>,
): Promise<Classification> {
    const key = cacheKey(signals)
    const hit = cacheGet(key)
    if (hit) return { ...hit, cached: true }

    await admitModelCall?.()

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
    const value = parseResponse(raw, signals.domain)
    cacheSet(key, value)
    return { ...value, cached: false }
}
