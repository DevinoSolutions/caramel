// src/lib/analytics/posthogHosts.ts
//
// Where the BROWSER's posthog-js talks to, as opposed to the server's
// posthog-node (which keeps the real PostHog host — server -> PostHog is not
// blocked, and routing it through our own rewrite would just add a hop).
//
// Production: `api_host` is the first-party telemetry path on OUR origin
// (next.config.mjs rewrites it to PostHog), `ui_host` stays the real PostHog
// host so toolbar / "view in PostHog" links resolve. e2e: untouched — the
// shared test project is reached directly, and next.config.mjs does not proxy
// it. Both sides use the SAME rule (dataset === 'production'), see
// telemetryProxy.mjs.
import type { PosthogTarget } from './posthogDataset'
import { TELEMETRY_PATH } from './telemetryProxy.mjs'

export interface BrowserPosthogHosts {
    apiHost: string
    /** Set only when `apiHost` is NOT the real PostHog host. */
    uiHost?: string
}

export function resolveBrowserPosthogHosts(
    target: PosthogTarget,
): BrowserPosthogHosts {
    if (target.environment === 'production') {
        return { apiHost: TELEMETRY_PATH, uiHost: target.host }
    }
    return { apiHost: target.host }
}
