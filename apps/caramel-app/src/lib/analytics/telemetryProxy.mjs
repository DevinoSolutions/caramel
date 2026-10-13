// src/lib/analytics/telemetryProxy.mjs
//
// The first-party path PostHog traffic travels on, and the next.config
// rewrites that serve it. Plain .mjs (not .ts) on purpose: next.config.mjs
// imports this at config-evaluation time, where TypeScript is not available,
// and the browser init (posthogHosts.ts) imports the SAME constant — one
// definition, so the rewrite source and the SDK's `api_host` cannot drift.
//
// Why a path on our own domain: content blockers match PostHog's hostname and
// the well-known proxy paths (/ingest, /posthog, /e), so a visitor with an ad
// blocker was invisible to the funnel. `/_t/k3v` is deliberately none of
// those. The path is a label, not a secret: it only has to not be on a filter
// list. Changing it is a one-line edit here (the e2e/dev/prod builds all pick
// it up) — but the PostHog toolbar/recordings keep working regardless, because
// the browser init also sets `ui_host` to the real PostHog host.

/** @type {'/_t/k3v'} */
export const TELEMETRY_PATH = '/_t/k3v'

/**
 * Pure: is `pathname` the telemetry prefix itself or anything under it?
 * Shared by the trailing-slash middleware (posthog-js POSTs to
 * `/_t/k3v/i/v0/e/`, `/_t/k3v/flags/`, `/_t/k3v/s/` WITH the trailing slash,
 * and a redirect there drops the capture).
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isTelemetryPath(pathname) {
    return (
        pathname === TELEMETRY_PATH || pathname.startsWith(`${TELEMETRY_PATH}/`)
    )
}

/**
 * The reserved `.invalid` TLD is what DESIGN.md §2(m) uses for build-time
 * placeholders: it can never resolve, so a rewrite to it would only ever be a
 * runtime 502. Treated as "no real PostHog host" rather than emitted.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isPlaceholderHost(hostname) {
    return hostname === 'invalid' || hostname.endsWith('.invalid')
}

/**
 * Pure: the `rewrites()` entries that proxy `TELEMETRY_PATH` to PostHog.
 *
 * - Only the `production` dataset is proxied. The browser init (posthogHosts.ts)
 *   uses the same rule; the shared e2e project keeps talking to its own host.
 * - An empty/unset host (dataset disabled, local builds) emits NO rewrites.
 * - A `.invalid` placeholder host emits none either (see isPlaceholderHost).
 * - A set-but-malformed host THROWS: building an image whose analytics path
 *   silently points nowhere is exactly the failure this config must not hide.
 *
 * Order matters (Next takes the first match): the static-asset and array
 * (remote-config + SDK bundle) routes MUST precede the catch-all, because
 * PostHog serves those from its asset path.
 *
 * @param {{ dataset?: string, host?: string }} input
 * @returns {{ source: string, destination: string }[]}
 */
export function buildTelemetryRewrites(input) {
    if (input.dataset !== 'production') return []
    const raw = input.host?.trim()
    if (!raw) return []

    let target
    try {
        target = new URL(raw)
    } catch (cause) {
        throw new Error(
            `NEXT_PUBLIC_POSTHOG_HOST is not a valid URL ("${raw}"): cannot build the ${TELEMETRY_PATH} PostHog proxy rewrites`,
            { cause },
        )
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        throw new Error(
            `NEXT_PUBLIC_POSTHOG_HOST must be http(s) ("${raw}"): cannot build the ${TELEMETRY_PATH} PostHog proxy rewrites`,
        )
    }
    if (isPlaceholderHost(target.hostname)) return []

    const origin = target.origin
    return [
        {
            source: `${TELEMETRY_PATH}/static/:path*`,
            destination: `${origin}/static/:path*`,
        },
        {
            source: `${TELEMETRY_PATH}/array/:path*`,
            destination: `${origin}/array/:path*`,
        },
        {
            source: `${TELEMETRY_PATH}/:path*`,
            destination: `${origin}/:path*`,
        },
    ]
}
