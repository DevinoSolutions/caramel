// src/lib/api/withRoute.ts
//
// F-007 — the one composable pipeline for API-route cross-cutting
// concerns. Before this, each of the 16 hand-rolled App Router routes
// opted into a different subset of CORS / rate-limit / origin-gate /
// api-key / body-parsing: identical CORS computed 3x by hand in
// extension/oauth/authorize (two of the three copies didn't even call
// the file's own local helper), extension/oauth's exchange route used a
// LOOSER CORS check than authorize, oauth/authorize did HMAC signing +
// read secrets with no rate limit at all, sites/suggest had neither a
// rate limit nor an origin gate. A missing concern was invisible because
// there was no one place that declared what every route *should* have.
//
// Routes now declare their concerns as data; withRoute enforces them the
// same way every time:
//
// ```ts
// export const POST = withRoute(
//     { method: 'POST', routeName: 'coupons/increment', rateLimit: 'mutation', origin: true, body: MyBodySchema },
//     async ({ req, body }) => { ... return NextResponse.json(...) },
// )
// export const OPTIONS = preflight({ cors: 'extension', methods: 'POST, OPTIONS' })
// ```
//
// Concern order (each an early return): compute CORS → origin-gate 403
// (origin: true = isOriginAllowed's permissive allowlist; origin:
// 'extension' = isExtensionOrigin's strict extension-protocol-only check,
// no missing-Origin bypass — D5) → apiKey 401 → auth 401 → rateLimit 429 →
// body safeParse 422 → handler
// (try/catch → F-002's handleRouteError). CORS headers are merged onto
// EVERY exit point (incl. 4xx/429/500) — matches the pre-F-007
// authorize/oauth-exchange behavior of attaching corsHeaders to their
// error responses too, so a preflight-passing extension can always read
// the error body.
import { handleRouteError } from '@/lib/api/handleRouteError'
import { env } from '@/lib/env'
import {
    checkRateLimit,
    forbiddenOrigin,
    isExtensionOrigin,
    isOriginAllowed,
    isTrustedServer,
    type LimitKind,
} from '@/lib/rateLimit'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import type { z } from 'zod'

export type CorsMode = 'none' | 'extension' | 'public'

// Exact env-allowlist — authorize/route.ts's pre-F-007 model (KNOWN_EXTENSION_ORIGINS),
// now the ONE way any route reflects an extension Origin. This TIGHTENS
// extension/oauth's exchange route, which used to accept ANY
// `chrome-extension://…` / `moz-extension://…` / `safari-web-extension://…`
// origin by prefix match rather than checking it against this allowlist
// (see PLAN-F-007.md §Breaking — the published extension's origin must
// already be here for authorize, which it calls first, to work today).
const KNOWN_EXTENSION_ORIGINS = [
    env.CHROME_EXTENSION_ORIGIN,
    env.FIREFOX_EXTENSION_ORIGIN,
    env.SAFARI_EXTENSION_ORIGIN,
].filter((o): o is string => Boolean(o))

/**
 * Computes the CORS headers for a request under `mode`. Returns an EMPTY
 * Headers (no CORS headers set at all) for `'none'`, and for `'extension'`
 * when the Origin isn't a known extension origin — mirrors pre-F-007
 * authorize/route.ts's getCorsHeaders(), which likewise emitted nothing
 * for an unrecognized Origin rather than an explicit denial.
 */
function computeCorsHeaders(
    req: NextRequest,
    mode: CorsMode,
    methods: string,
): Headers {
    const headers = new Headers()
    if (mode === 'none') return headers

    if (mode === 'public') {
        headers.set('Access-Control-Allow-Origin', '*')
        headers.set('Access-Control-Allow-Methods', methods)
        headers.set('Access-Control-Allow-Headers', 'Content-Type')
        return headers
    }

    const origin = req.headers.get('origin')
    if (origin && KNOWN_EXTENSION_ORIGINS.includes(origin)) {
        headers.set('Access-Control-Allow-Origin', origin)
        headers.set('Access-Control-Allow-Methods', methods)
        headers.set('Access-Control-Allow-Headers', 'Content-Type')
    }
    return headers
}

/** Merges `cors` onto `res` in place and returns it. */
function withCors(res: NextResponse, cors: Headers): NextResponse {
    cors.forEach((value, key) => res.headers.set(key, value))
    return res
}

function unauthorized(cors: Headers): NextResponse {
    return withCors(
        NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
        cors,
    )
}

// better-auth's session type, resolved purely at the type level (no
// runtime import of '@/lib/auth/auth' unless a route actually opts into
// `auth: 'session'` — see the dynamic import below). Not exercised by any
// current route (F-007 establishes the mechanism; nothing needs it yet).
type Session = Awaited<
    ReturnType<typeof import('@/lib/auth/auth').auth.api.getSession>
>

export interface RouteConfig<TBody> {
    /** HTTP method this export serves. Next's router already dispatches
     * by export name (GET/POST/...) before this ever runs — this field
     * only feeds the Allow-Methods CORS header. */
    method: string
    /** Sentry route tag (F-002) used when the handler throws uncaught. */
    routeName: string
    cors?: CorsMode
    /** rate-limit bucket kind — omit for routes that intentionally stay
     * unthrottled (health/db's monitoring probe, oauth/redirect's
     * provider-server callback). */
    rateLimit?: LimitKind
    /** Reject cross-origin browser requests via rateLimit.ts's
     * isOriginAllowed() allowlist (`true`), OR — for routes that must be
     * reachable ONLY from the extension itself (e.g. a paid LLM-backed
     * endpoint) — require a strict extension-protocol Origin via
     * isExtensionOrigin() (`'extension'`), which unlike isOriginAllowed()
     * does NOT let a missing Origin through (D5). */
    origin?: boolean | 'extension'
    /** Server-only COUPONS_ADMIN_SECRET bearer gate (rateLimit.ts's
     * isTrustedServer) — the ONE api-key checker (CR-8: models
     * coupons/expire's Authorization: Bearer gate; not a second,
     * independently-written checker). */
    apiKey?: 'trustedServer'
    /** better-auth session gate. */
    auth?: 'session'
    /** zod schema the JSON body must satisfy — 422 on mismatch. Omit (or
     * null) for routes that parse their own body (classify-cart's
     * sanitize(), oauth/redirect's formData/query, and the GET routes
     * that have no body at all). */
    body?: z.ZodType<TBody> | null
}

export interface RouteContext<TBody> {
    req: NextRequest
    body: TBody
    session: Session | null
    /** The CORS headers already computed for this request — withRoute
     * merges these onto whatever the handler returns automatically;
     * exposed here only for handlers that need to inspect them. */
    cors: Headers
}

export type RouteHandler<TBody> = (
    ctx: RouteContext<TBody>,
) => Promise<NextResponse> | NextResponse

/**
 * Wraps an App Router method handler with the declared cross-cutting
 * concerns. See the module doc comment for the concern order.
 */
export function withRoute<TBody = undefined>(
    config: RouteConfig<TBody>,
    handler: RouteHandler<TBody>,
) {
    const methods = `${config.method}, OPTIONS`

    return async function wrappedRoute(
        req: NextRequest,
    ): Promise<NextResponse> {
        const cors = computeCorsHeaders(req, config.cors ?? 'none', methods)

        if (config.origin === 'extension') {
            if (!isExtensionOrigin(req))
                return withCors(forbiddenOrigin(), cors)
        } else if (config.origin && !isOriginAllowed(req)) {
            return withCors(forbiddenOrigin(), cors)
        }

        if (config.apiKey === 'trustedServer' && !isTrustedServer(req)) {
            return unauthorized(cors)
        }

        let session: Session | null = null
        if (config.auth === 'session') {
            // Lazy import — only routes that opt into session-auth pull in
            // the full better-auth graph (bcrypt, prisma, email templates).
            // No current route does; this keeps the other 15 routes'
            // dependency graph exactly what it was pre-F-007.
            const { auth } = await import('@/lib/auth/auth')
            session = await auth.api.getSession({ headers: req.headers })
            if (!session) return unauthorized(cors)
        }

        if (config.rateLimit) {
            const limited = await checkRateLimit(req, config.rateLimit)
            if (limited) return withCors(limited, cors)
        }

        let body = undefined as TBody
        if (config.body) {
            const raw = await req.json().catch(() => undefined)
            const parsed = config.body.safeParse(raw ?? {})
            if (!parsed.success) {
                return withCors(
                    NextResponse.json(
                        { error: 'Invalid request body' },
                        { status: 422 },
                    ),
                    cors,
                )
            }
            body = parsed.data
        }

        try {
            const res = await handler({ req, body, session, cors })
            return withCors(res, cors)
        } catch (error) {
            return withCors(
                handleRouteError(error, {
                    req,
                    route: config.routeName,
                    message: 'Internal server error',
                }),
                cors,
            )
        }
    }
}

/** Standard auto-OPTIONS handler — 204 + the same CORS computation
 * withRoute uses for the matching method handler. */
export function preflight(config: { cors: CorsMode; methods: string }) {
    return async function optionsHandler(
        req: NextRequest,
    ): Promise<NextResponse> {
        const cors = computeCorsHeaders(req, config.cors, config.methods)
        return withCors(new NextResponse(null, { status: 204 }), cors)
    }
}
