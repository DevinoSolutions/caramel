// src/lib/couponBoxPick.ts
//
// Coupon-box pick: when the extension's rules cannot find a store's coupon
// code box, it sends a privacy-trimmed outline of the cart page and a model
// picks which element is the coupon input, its apply button, or the toggle
// that reveals a hidden box.
//
// The outline is accessibility-tree style, one node per line:
//
//   - form:
//     - [7] textbox "Discount Code (Optional)"
//     - [8] button "Apply"
//
// Interactive nodes carry an `[n]` index the extension maps back to the real
// element; the extension has already replaced every digit in the labels with
// `#` and carries no free page text. This module re-scrubs anyway (defence in
// depth) and only ever returns indexes that exist in the outline it was given.
//
// Eval-gated: evals/couponBoxPick.eval.ts runs THIS module (prompt, parsing,
// index validation — imported, never copied) against labelled real cart pages.
// Change the prompt or the model only through that suite (evals/README.md).
import { env } from '@/lib/env'
import { firstJsonObject } from '@/lib/llmJson'
import { chat } from '@/lib/openrouter'
import { createTtlLruCache } from '@/lib/ttlLruCache'
import * as Sentry from '@sentry/nextjs'
import crypto from 'node:crypto'
import { z } from 'zod'

/** Largest outline the pick accepts, in UTF-8 bytes. The route caps the whole
 * request body a little above this. */
export const MAX_OUTLINE_BYTES = 16 * 1024

// The system prompt, verbatim as it was measured (see the eval scoreboard).
const SYSTEM_PROMPT = [
    'You find the coupon / promo / discount code box on a shopping cart or checkout page.',
    'You get the page\'s accessibility tree (role "name": text), in reading order. Every input and clickable element is prefixed [n]. Answer with those n numbers.',
    'Answer JSON only, no prose: {"input": <n or null>, "button": <n or null>, "toggle": <n or null>, "confidence": 0-100, "why": "<10 words>"}',
    '- "input": the field where a shopper types a coupon, promo, discount, voucher or gift-card-or-discount code. Never a search box, postcode, quantity, newsletter/email, gift message or loyalty-number field, and never a field that takes ONLY a gift card.',
    '- A hidden or disabled input can still be THE box (behind a "Have a promo code?" link, or disabled on an empty cart).',
    '- "button": the control that applies that code (Apply, Redeem, OK, Submit beside the box). Never checkout, pay, place-order, remove or sign-in.',
    '- "toggle": the control that reveals a hidden box ("Have a promo code?", "Promo code +", "Add discount code"); else null.',
    '- No coupon box and no toggle on the page: input null and toggle null. A wrong field is worse than none.',
].join('\n')

// A reasoning model's hidden reasoning counts against max_tokens (the F-017
// lesson in evals/SCOREBOARD.md), so this is sized for the reasoning plus a
// one-line JSON answer, not for the answer alone.
const MAX_TOKENS = 1000
// Measured on the eval set (sequential): p50 ~4s, slowest answer 13.6s.
const TIMEOUT_MS = 20_000
const WHY_MAX_CHARS = 200
const RAW_REPLY_LOG_MAX = 300

export const couponBoxPickRequestSchema = z.object({
    domain: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9.-]{3,120}$/),
    outline: z.string().min(1),
})

export type CouponBoxPickRequest = z.infer<typeof couponBoxPickRequestSchema>

/** The model found the box (`input`) or a control that reveals it (`toggle`);
 * at least one of the two is set. Every index exists in the outline. */
interface CouponBoxFound {
    outcome: 'box'
    input: number | null
    button: number | null
    toggle: number | null
    confidence: number
    why: string
    cached: boolean
}

/** The model answered, and its answer is that the page has no coupon box. */
interface CouponBoxAbsent {
    outcome: 'no_box'
    confidence: number
    why: string
    cached: boolean
}

/** No answer: the feature is off, or the model call failed or returned
 * something unusable. The extension treats it exactly like "rules found
 * nothing". */
interface CouponBoxNoPick {
    outcome: 'no_pick'
    reason: 'disabled' | 'model_error' | 'unparsable'
}

export type CouponBoxPickResult =
    | CouponBoxFound
    | CouponBoxAbsent
    | CouponBoxNoPick

type CachedAnswer =
    | Omit<CouponBoxFound, 'cached'>
    | Omit<CouponBoxAbsent, 'cached'>

export class CouponBoxOutlineTooLargeError extends Error {
    constructor(readonly bytes: number) {
        super(
            `coupon-box outline is ${bytes} bytes; the limit is ${MAX_OUTLINE_BYTES}`,
        )
        this.name = 'CouponBoxOutlineTooLargeError'
    }
}

/** The feature switch the route and the extension's feature read share: on
 * only when explicitly enabled AND a model is configured. */
export function couponBoxLlmEnabled(): boolean {
    return env.COUPON_BOX_LLM_ENABLED && Boolean(env.COUPON_BOX_PICK_MODEL)
}

const EMAIL_SHAPED = /[\w.+-]+@[\w-]+\.[\w.]+/g
// A node line's leading `- [n] ` index. The only digits the outline may keep.
const NODE_INDEX = /^(\s*- \[\d+\] )?(.*)$/

function scrubText(text: string): string {
    return text.replace(EMAIL_SHAPED, '[email]').replace(/\d/g, '#')
}

/** Every digit becomes `#` and anything email-shaped becomes `[email]`,
 * except the `[n]` index at the start of a node line (the extension maps the
 * pick back through it). */
export function scrubOutline(outline: string): string {
    return outline
        .split('\n')
        .map(line => {
            const m = NODE_INDEX.exec(line)
            return (m?.[1] ?? '') + scrubText(m?.[2] ?? line)
        })
        .join('\n')
}

function outlineIndexes(outline: string): Set<number> {
    return new Set(
        Array.from(outline.matchAll(/^\s*- \[(\d+)\] /gm), m => Number(m[1])),
    )
}

const indexSchema = z.number().int().nonnegative().nullable().default(null)

const answerSchema = z.object({
    input: indexSchema,
    button: indexSchema,
    toggle: indexSchema,
    confidence: z.number().min(0).max(100),
    why: z.string().transform(s => s.slice(0, WHY_MAX_CHARS)),
})

function parseAnswer(raw: string): z.infer<typeof answerSchema> | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        try {
            parsed = firstJsonObject(raw)
        } catch {
            return null
        }
    }
    const result = answerSchema.safeParse(parsed)
    return result.success ? result.data : null
}

/** An index the outline does not contain is a hallucination: it becomes null.
 * With neither an input nor a toggle left, the answer is "no box". */
function toCachedAnswer(
    answer: z.infer<typeof answerSchema>,
    outline: string,
): CachedAnswer {
    const known = outlineIndexes(outline)
    const real = (n: number | null) => (n !== null && known.has(n) ? n : null)
    const input = real(answer.input)
    const toggle = real(answer.toggle)
    if (input === null && toggle === null) {
        return {
            outcome: 'no_box',
            confidence: answer.confidence,
            why: answer.why,
        }
    }
    return {
        outcome: 'box',
        input,
        button: real(answer.button),
        toggle,
        confidence: answer.confidence,
        why: answer.why,
    }
}

const cache = createTtlLruCache<CachedAnswer>({
    ttlMs: 24 * 60 * 60 * 1000,
    maxEntries: 2000,
})

function cacheKey(domain: string, outline: string): string {
    return crypto
        .createHash('sha256')
        .update(`${domain}\n${outline}`)
        .digest('hex')
}

/**
 * Pick the coupon box on one page outline.
 *
 * `admitModelCall` runs only on a cache MISS, immediately before the paid
 * model call, and may throw to refuse it (the route passes the coupon-box
 * budget, couponBoxPickBudget.ts); that refusal propagates. The eval harness
 * omits it — evals measure the model, not the budget.
 *
 * Never throws for a model failure: an error or an unusable reply is logged
 * to Sentry and answered as `no_pick`. Throws CouponBoxOutlineTooLargeError
 * for an outline over MAX_OUTLINE_BYTES (the route rejects those first).
 */
export async function pickCouponBox(
    request: CouponBoxPickRequest,
    admitModelCall?: () => Promise<void>,
): Promise<CouponBoxPickResult> {
    const bytes = Buffer.byteLength(request.outline, 'utf8')
    if (bytes > MAX_OUTLINE_BYTES)
        throw new CouponBoxOutlineTooLargeError(bytes)

    const model = env.COUPON_BOX_PICK_MODEL
    if (!model) return { outcome: 'no_pick', reason: 'disabled' }

    const outline = scrubOutline(request.outline)
    const key = cacheKey(request.domain, outline)
    const hit = cache.get(key)
    if (hit) return { ...hit, cached: true }

    await admitModelCall?.()

    let raw: string
    try {
        raw = await chat(
            [
                { role: 'system', content: SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: `Store: ${request.domain}\n\n${outline}`,
                },
            ],
            {
                model,
                temperature: 0,
                maxTokens: MAX_TOKENS,
                responseFormat: 'json_object',
                timeoutMs: TIMEOUT_MS,
                // Pins the exact model on a relay that would otherwise fall
                // back to another one; ignored by a provider that does not
                // know it.
                headers: { 'X-ORF-Strict': '1' },
            },
        )
    } catch (error) {
        console.error('[coupon-box-pick] model call failed', error)
        Sentry.captureException(error, {
            tags: { surface: 'coupon-box-pick', operation: 'model_call' },
            extra: { domain: request.domain, model },
        })
        return { outcome: 'no_pick', reason: 'model_error' }
    }

    const answer = parseAnswer(raw)
    if (!answer) {
        console.error('[coupon-box-pick] unusable model reply', {
            domain: request.domain,
            reply: raw.slice(0, RAW_REPLY_LOG_MAX),
        })
        Sentry.captureMessage('coupon-box-pick: unusable model reply', {
            level: 'warning',
            tags: { surface: 'coupon-box-pick', operation: 'parse' },
            fingerprint: ['coupon-box-pick', 'unusable-reply'],
            extra: {
                domain: request.domain,
                model,
                reply: raw.slice(0, RAW_REPLY_LOG_MAX),
            },
        })
        return { outcome: 'no_pick', reason: 'unparsable' }
    }

    const value = toCachedAnswer(answer, outline)
    cache.set(key, value)
    return { ...value, cached: false }
}
