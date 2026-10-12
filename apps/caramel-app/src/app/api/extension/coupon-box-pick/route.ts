import { handleRouteError } from '@/lib/api/handleRouteError'
import { preflight, withRoute } from '@/lib/api/withRoute'
import {
    couponBoxLlmEnabled,
    couponBoxPickRequestSchema,
    MAX_OUTLINE_BYTES,
    pickCouponBox,
    type CouponBoxPickResult,
} from '@/lib/couponBoxPick'
import { admitCouponBoxPickModelCall } from '@/lib/couponBoxPickBudget'
import { ModelCallBudgetExceededError } from '@/lib/modelCallBudget'
import { getClientIp } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

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
const MAX_BODY_BYTES = 20 * 1024

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
        // Off (the default) never reads the body and never calls a model.
        if (!couponBoxLlmEnabled()) {
            return json({ outcome: 'no_pick', reason: 'disabled' })
        }

        const contentLength = Number(req.headers.get('content-length') || 0)
        if (contentLength > MAX_BODY_BYTES) {
            return json({ error: 'payload too large' }, 413)
        }
        // A chunked body carries no Content-Length: measure what arrived.
        const text = await req.text()
        if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
            return json({ error: 'payload too large' }, 413)
        }

        let raw: unknown
        try {
            raw = JSON.parse(text)
        } catch {
            return json({ error: 'invalid payload' }, 400)
        }
        const parsed = couponBoxPickRequestSchema.safeParse(raw)
        if (!parsed.success) {
            return json({ error: 'invalid payload' }, 400)
        }
        if (
            Buffer.byteLength(parsed.data.outline, 'utf8') > MAX_OUTLINE_BYTES
        ) {
            return json({ error: 'outline too large' }, 413)
        }

        try {
            const result = await pickCouponBox(parsed.data, () =>
                admitCouponBoxPickModelCall({
                    ip: getClientIp(req),
                    path: req.nextUrl.pathname,
                    userAgent:
                        req.headers.get('user-agent')?.slice(0, 80) ?? '-',
                }),
            )
            return json(result)
        } catch (error) {
            // The spend ceiling — an expected refusal, already reported by the
            // budget, so a 429 and not a Sentry exception.
            if (error instanceof ModelCallBudgetExceededError) {
                return NextResponse.json(
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
                )
            }
            console.error('[coupon-box-pick] failed', error)
            return handleRouteError(error, {
                req,
                message:
                    error instanceof Error
                        ? error.message
                        : 'coupon-box pick failed',
                status: 500,
            })
        }
    },
)
