import {
    scheduleCouponBoxPickOutcome,
    type CouponBoxPickOutcome,
    type CouponBoxPickOutcomeEvent,
} from '@/lib/analytics/couponBoxPickOutcome'
import { handleRouteError } from '@/lib/api/handleRouteError'
import { readBodyCapped } from '@/lib/api/readBodyCapped'
import { preflight, withRoute } from '@/lib/api/withRoute'
import {
    couponBoxLlmEnabled,
    couponBoxPickRequestSchema,
    MAX_OUTLINE_BYTES,
    pickCouponBox,
    type CouponBoxPickResult,
} from '@/lib/couponBoxPick'
import { admitCouponBoxPickModelCall } from '@/lib/couponBoxPickBudget'
import { env } from '@/lib/env'
import { ModelCallBudgetExceededError } from '@/lib/modelCallBudget'
import { getClientIp } from '@/lib/rateLimit'
import { NextResponse, type NextRequest } from 'next/server'

// POST /api/extension/coupon-box-pick — when the extension's rules cannot
// find a store's coupon box, it sends { domain, outline } (a privacy-trimmed
// accessibility outline of the cart page, see src/lib/couponBoxPick.ts) and
// gets back which outline index is the coupon input, its apply button, or the
// toggle that reveals the box. Every answer except a refusal is a 200 the
// extension can act on; `outcome: 'no_pick'` means "carry on as if the rules
// found nothing".

// The outline cap plus room for the JSON envelope: escaping the outline's
// quotes and newlines adds up to ~13% on real cart pages (measured on the
// eval fixtures), so a maximal outline still fits.
const MAX_BODY_BYTES = 46 * 1024

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

function json(body: CouponBoxPickResult | { error: string }, status = 200) {
    return NextResponse.json(body, { status, headers: NO_STORE })
}

export const OPTIONS = preflight({
    cors: 'extension',
    methods: 'POST, OPTIONS',
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'extension/coupon-box-pick',
        rateLimit: 'mutation',
        cors: 'extension',
        // Paid, LLM-backed, extension-only — the same gate as classify-cart:
        // the Origin must be present AND a browser-extension protocol. It
        // only stops browsers (any HTTP client can forge the header), so the
        // real bound on spend is the model-call budget below
        // (couponBoxPickBudget.ts).
        origin: 'extension',
        // Parses its own body: the size cap must run before the JSON parse.
        body: null,
    },
    async ({ req }) => {
        // Outcome telemetry (couponBoxPickOutcome.ts): ONE event per request
        // that reaches this handler, whichever way it ends. Requests withRoute
        // refuses first (the Origin gate, the rate limit) are not recorded.
        const startedAt = performance.now()
        const model = env.COUPON_BOX_PICK_MODEL ?? null
        let exit: PickExit
        try {
            exit = await handlePick(req)
        } catch (error) {
            // Only reachable if reading the body itself fails; withRoute turns
            // it into the 500. Record it, then rethrow unchanged.
            scheduleCouponBoxPickOutcome({
                outcome: 'server_error',
                cached: null,
                latencyMs: performance.now() - startedAt,
                modelMs: null,
                store: null,
                model,
            })
            throw error
        }
        scheduleCouponBoxPickOutcome({
            ...exit.event,
            latencyMs: performance.now() - startedAt,
            model,
        })
        return exit.response
    },
)

/** What one request produced: the response, and everything the outcome event
 * needs that only the request knows. */
interface PickExit {
    response: NextResponse
    event: Omit<CouponBoxPickOutcomeEvent, 'latencyMs' | 'model'>
}

function exit(
    response: NextResponse,
    outcome: CouponBoxPickOutcome,
    extra: Partial<Omit<PickExit['event'], 'outcome'>> = {},
): PickExit {
    return {
        response,
        event: {
            outcome,
            cached: null,
            modelMs: null,
            store: null,
            ...extra,
        },
    }
}

function outcomeOf(result: CouponBoxPickResult): CouponBoxPickOutcome {
    return result.outcome === 'no_pick'
        ? `no_pick:${result.reason}`
        : result.outcome
}

async function handlePick(req: NextRequest): Promise<PickExit> {
    // Off (the default) never reads the body and never calls a model.
    if (!couponBoxLlmEnabled()) {
        return exit(
            json({ outcome: 'no_pick', reason: 'disabled' }),
            'no_pick:disabled',
        )
    }

    // Read no further than the cap, chunked bodies included.
    const body = await readBodyCapped(req, MAX_BODY_BYTES)
    if (!body.ok) {
        return exit(json({ error: 'payload too large' }, 413), 'too_large')
    }

    let raw: unknown
    try {
        raw = JSON.parse(body.text)
    } catch {
        return exit(json({ error: 'invalid payload' }, 400), 'invalid')
    }
    const parsed = couponBoxPickRequestSchema.safeParse(raw)
    if (!parsed.success) {
        return exit(json({ error: 'invalid payload' }, 400), 'invalid')
    }
    // The domain is valid from here on, so the event may carry it.
    const store = parsed.data.domain
    if (Buffer.byteLength(parsed.data.outline, 'utf8') > MAX_OUTLINE_BYTES) {
        return exit(json({ error: 'outline too large' }, 413), 'too_large', {
            store,
        })
    }

    // Set when the budget admitted a model call: pickCouponBox is then in the
    // model call, so its remaining time is the model's (the cache lookup and
    // scrub before the admit are in-memory and microseconds).
    let modelStartedAt: number | null = null
    const modelMs = () =>
        modelStartedAt === null ? null : performance.now() - modelStartedAt
    try {
        const result = await pickCouponBox(parsed.data, async () => {
            await admitCouponBoxPickModelCall({
                ip: getClientIp(req),
                path: req.nextUrl.pathname,
                userAgent: req.headers.get('user-agent')?.slice(0, 80) ?? '-',
            })
            modelStartedAt = performance.now()
        })
        return exit(json(result), outcomeOf(result), {
            // A `disabled` no_pick never looked at the cache; a refused
            // button is a model answer, cached like one.
            cached:
                'cached' in result
                    ? result.cached
                    : result.reason === 'disabled'
                      ? null
                      : false,
            modelMs: modelMs(),
            store,
        })
    } catch (error) {
        // The spend ceiling — an expected refusal, already reported by the
        // budget, so a 429 and not a Sentry exception.
        if (error instanceof ModelCallBudgetExceededError) {
            return exit(
                NextResponse.json(
                    {
                        error: 'Too many requests. Please slow down.',
                        retryAfter: error.retryAfterSec,
                    },
                    {
                        status: 429,
                        headers: {
                            ...NO_STORE,
                            'Retry-After': String(error.retryAfterSec),
                        },
                    },
                ),
                `budget_exceeded:${error.scope}`,
                // A budget refusal comes after the cache miss.
                { cached: false, store },
            )
        }
        console.error('[coupon-box-pick] failed', error)
        return exit(
            handleRouteError(error, {
                req,
                message:
                    error instanceof Error
                        ? error.message
                        : 'coupon-box pick failed',
                status: 500,
            }),
            'server_error',
            { modelMs: modelMs(), store },
        )
    }
}
