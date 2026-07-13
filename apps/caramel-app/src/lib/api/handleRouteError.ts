import * as Sentry from '@sentry/nextjs'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

export interface HandleRouteErrorOptions {
    /** The inbound request — supplies the `route` (pathname) and `method`
     * Sentry tags when `route` isn't given explicitly. Every route handler
     * already has this in scope. */
    req?: NextRequest
    /** Overrides the derived route tag for call sites without a `req`. */
    route?: string
    /** Body of the `{error}` response returned to the caller. */
    message?: string
    /** HTTP status code. Defaults to 500. */
    status?: number
    /** Extra response headers to preserve (e.g. CORS) — merged with the
     * `x-request-id` header this helper always sets. */
    headers?: HeadersInit
}

/**
 * Standard error-path boundary for API route catch blocks (F-002).
 *
 * Before this helper, every `catch (error) { ... return NextResponse.json(...) }`
 * site swallowed the error into a 500 response without ever reporting it —
 * only UNCAUGHT errors reached Sentry, via instrumentation.ts's
 * `onRequestError`. This helper closes that gap: every caught route error
 * is (1) reported to Sentry with request context and (2) turned into a
 * standardized, distinguishable `{error}` envelope — never a fake-success
 * shape.
 *
 * ```ts
 * } catch (error) {
 *     console.error('Error fetching coupons:', error)
 *     return handleRouteError(error, { req, message: 'Error fetching coupons.' })
 * }
 * ```
 */
export function handleRouteError(
    error: unknown,
    options: HandleRouteErrorOptions = {},
): NextResponse {
    const {
        req,
        route,
        message = 'Internal server error',
        status = 500,
        headers,
    } = options

    const derivedRoute = route ?? (req ? new URL(req.url).pathname : undefined)
    const requestId = crypto.randomUUID()

    Sentry.captureException(error, {
        tags: {
            ...(derivedRoute ? { route: derivedRoute } : {}),
            ...(req?.method ? { method: req.method } : {}),
            requestId,
        },
    })

    const responseHeaders = new Headers(headers)
    responseHeaders.set('x-request-id', requestId)

    return NextResponse.json(
        { error: message },
        { status, headers: responseHeaders },
    )
}
