// src/lib/pageMethods.ts
//
// Pure half of the page-method guard that src/middleware.ts owns (T-7839).
//
// The app has no server actions, and every route handler outside /api is a
// GET-only text route (llms.txt, security.txt, the Markdown twins). So a POST
// (or PUT, DELETE...) to a page is never ours: crawlers send them, and Next
// answered a POST to an unknown page by rendering /_not-found as an action
// response and throwing "Invariant: Expected RSC response, got text/plain"
// into Sentry (CARAMEL-2S). The middleware answers 405 before Next renders.
//
// Every method stays open on the paths that take writes:
//  - /api/*: the API (including Apple's form_post sign-in callback);
//  - the PostHog telemetry prefix (posthog-js POSTs its events there);
//  - the Sentry tunnel (`tunnelRoute` in next.config.mjs): the browser SDK
//    POSTs its error reports there, and refusing them would silence the
//    client side of Sentry without a trace.
import { isTelemetryPath } from './analytics/telemetryProxy.mjs'

/** What a page answers to, for the 405's Allow header. */
export const PAGE_METHODS = 'GET, HEAD, OPTIONS'

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Must match `tunnelRoute` in next.config.mjs. */
export const SENTRY_TUNNEL_PATH = '/monitoring'

function startsSegment(pathname: string, prefix: string): boolean {
    return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** True when `method` on `pathname` is a write to a page, which no page takes. */
export function refusesPageMethod(method: string, pathname: string): boolean {
    if (READ_METHODS.has(method.toUpperCase())) return false
    if (startsSegment(pathname, '/api')) return false
    if (startsSegment(pathname, SENTRY_TUNNEL_PATH)) return false
    if (isTelemetryPath(pathname)) return false
    return true
}
