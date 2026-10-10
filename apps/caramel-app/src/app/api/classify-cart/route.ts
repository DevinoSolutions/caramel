import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { classifyCart, type CartSignals } from '@/lib/cartClassifier'
import {
    admitClassifyModelCall,
    ClassifyModelBudgetExceededError,
} from '@/lib/classifyCartModelBudget'
import { OpenRouterError } from '@/lib/openrouter'
import { getClientIp } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Cap payload size to protect the route from noisy senders.
const MAX_BODY_BYTES = 8 * 1024

function sanitize(body: unknown): CartSignals | null {
    if (!body || typeof body !== 'object') return null
    const b = body as Record<string, unknown>
    const domain =
        typeof b.domain === 'string' ? b.domain.trim().toLowerCase() : ''
    if (!domain || !/^[a-z0-9.-]{3,120}$/.test(domain)) return null

    const str = (v: unknown, max: number) =>
        typeof v === 'string' ? v.slice(0, max) : undefined
    const arr = (v: unknown, maxN: number, maxLen: number) =>
        Array.isArray(v)
            ? v
                  .filter(x => typeof x === 'string')
                  .map(x => (x as string).slice(0, maxLen))
                  .slice(0, maxN)
            : undefined

    return {
        domain,
        url_path: str(b.url_path, 200),
        title: str(b.title, 200),
        meta_description: str(b.meta_description, 400),
        og_site_name: str(b.og_site_name, 80),
        og_type: str(b.og_type, 40),
        cart_items: arr(b.cart_items, 6, 160),
        platform_hints:
            b.platform_hints && typeof b.platform_hints === 'object'
                ? (Object.fromEntries(
                      (
                          Object.entries(
                              b.platform_hints as Record<string, unknown>,
                          ).filter(([, v]) => typeof v === 'boolean') as [
                              string,
                              boolean,
                          ][]
                      ).slice(0, 10),
                  ) as Record<string, boolean>)
                : undefined,
    }
}

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'classify-cart',
        rateLimit: 'mutation',
        // Paid, LLM-backed, extension-only endpoint (no web-app page calls
        // it — grep-confirmed). The origin gate below only stops BROWSERS:
        // any HTTP client can send `Origin: chrome-extension://…`, so the
        // real bound on spend is the model-call budget passed to
        // classifyCart (classifyCartModelBudget.ts). origin: true's isOriginAllowed() lets a
        // request with NO Origin header through by design (server-to-
        // server/curl), which left this route reachable origin-less (E2E
        // report D5). 'extension' requires the Origin to be present AND an
        // actual browser-extension protocol — real calls are unaffected:
        // they originate from background.js's service-worker fetch, which
        // always carries `Origin: chrome-extension://<id>`.
        origin: 'extension',
        // Keeps its own sanitize() below (already validated-or-400, not a
        // swallow) rather than a wrapper zod schema — see PLAN-F-007.md
        // §Scope.
        body: null,
    },
    async ({ req }) => {
        const contentLength = Number(req.headers.get('content-length') || 0)
        if (contentLength > MAX_BODY_BYTES) {
            return NextResponse.json(
                { error: 'payload too large' },
                { status: 413 },
            )
        }

        const raw = await req.json().catch(() => null)
        const signals = sanitize(raw)
        if (!signals) {
            return NextResponse.json(
                { error: 'invalid payload' },
                { status: 400 },
            )
        }

        try {
            const result = await classifyCart(signals, () =>
                admitClassifyModelCall({
                    ip: getClientIp(req),
                    path: req.nextUrl.pathname,
                    userAgent:
                        req.headers.get('user-agent')?.slice(0, 80) ?? '-',
                }),
            )
            return NextResponse.json(result, {
                headers: {
                    'Cache-Control': 'private, no-store',
                },
            })
        } catch (error) {
            // The spend ceiling (classifyCartModelBudget.ts) — an expected
            // refusal, already reported there, so it is a 429 and NOT routed
            // through handleRouteError's Sentry exception path. The extension
            // treats any non-2xx as "no category hint" and carries on.
            if (error instanceof ClassifyModelBudgetExceededError) {
                return NextResponse.json(
                    {
                        error: 'Too many requests. Please slow down.',
                        retryAfter: error.retryAfterSec,
                    },
                    {
                        status: 429,
                        headers: {
                            'Retry-After': String(error.retryAfterSec),
                            'Cache-Control': 'private, no-store',
                        },
                    },
                )
            }
            console.error('[classify-cart] failed', error)
            return handleRouteError(error, {
                req,
                message:
                    error instanceof Error
                        ? error.message
                        : 'classification failed',
                status: error instanceof OpenRouterError ? 502 : 500,
            })
        }
    },
)
