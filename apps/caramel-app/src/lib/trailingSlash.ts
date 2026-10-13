// src/lib/trailingSlash.ts
//
// Pure half of the trailing-slash redirect that src/middleware.ts owns.
//
// next.config.mjs sets `skipTrailingSlashRedirect: true` so posthog-js's
// trailing-slash capture endpoints (`/_t/k3v/i/v0/e/`) are not 308'd — a
// redirected POST is a lost event. That flag is GLOBAL: with it on, `/stores/`
// and `/stores` would both serve 200, i.e. every page gets a duplicate URL
// (an SEO regression Search Console reports as "duplicate, Google chose
// different canonical"). This function reproduces Next's old default for
// everything except the telemetry prefix: strip the trailing slash.
import { isTelemetryPath } from './analytics/telemetryProxy.mjs'

/**
 * The pathname a request should be redirected to (308) to drop its trailing
 * slash, or `null` when no redirect applies:
 *  - no trailing slash already,
 *  - the root `/` (a slash IS the root path),
 *  - the telemetry prefix and anything under it (POSTs must not redirect).
 *
 * Runs of slashes (`/foo//`) collapse to nothing, as Next did. The query
 * string is not this function's business: the middleware clones the URL, so it
 * rides along untouched.
 */
export function trailingSlashRedirectPath(pathname: string): string | null {
    if (!pathname.endsWith('/')) return null
    if (isTelemetryPath(pathname)) return null
    const stripped = pathname.replace(/\/+$/, '')
    return stripped === '' ? null : stripped
}
