// src/lib/rejectedRedirectEventScrub.ts
//
// Keeps the OAuth query string out of the "rejected extension redirect" Sentry
// events. The request that triggered such an event is a provider callback, so
// its URL carries `?code=…&state=…`. sentryPiiScrub already redacts those
// params for every event; this scrub is the stricter, tag-keyed layer for our
// own events: the whole query string, fragment, cookies and body go, keyed on
// the tag reportRejectedExtensionRedirect sets. beforeSend is the last hook
// before the event leaves the process (sentry.common.config.ts). Deliberately light on imports (types
// only) so the Sentry init files can use it.
import type { ErrorEvent } from '@sentry/nextjs'

/** Tag value set by reportRejectedExtensionRedirect; the scrub keys on it. */
export const REJECTED_REDIRECT_SURFACE_TAG = 'extension-oauth-rejected-redirect'

/** Remove the query string, fragment, cookies and body from the event's
 * request if the event is one of ours. Any other event is returned untouched. */
export function scrubRejectedRedirectEvent<T extends ErrorEvent>(event: T): T {
    if (event.tags?.surface !== REJECTED_REDIRECT_SURFACE_TAG) return event
    const request = event.request
    if (!request) return event
    delete request.query_string
    delete request.cookies
    delete request.data
    if (typeof request.url === 'string') {
        const cut = request.url.search(/[?#]/)
        if (cut !== -1) request.url = request.url.slice(0, cut)
    }
    return event
}
