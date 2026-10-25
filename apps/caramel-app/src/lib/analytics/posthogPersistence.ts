// src/lib/analytics/posthogPersistence.ts
//
// Removes posthog-js's persisted identity (`ph_<project token>_posthog`, a
// localStorage entry mirrored into a first-party cookie, holding the distinct
// id) without needing the SDK to be loaded. After an account deletion the
// browser must not keep that id: a later capture would send events under the
// deleted person's id and PostHog would re-create the person. posthog.reset()
// does this when the SDK is live (identity.ts resetPosthogIdentity); this
// covers the case where it is not (blocked, failed to load, not yet loaded).
//
// Throws on a storage error so the caller can report it (identity.ts does).
// Browser only: reads window/document.

/** Cookie `Domain=` candidates for a hostname: itself and every parent suffix with 2+ labels. */
function cookieDomains(hostname: string): string[] {
    const labels = hostname.split('.')
    const domains: string[] = []
    for (let i = 0; i <= labels.length - 2; i++) {
        domains.push(labels.slice(i).join('.'))
    }
    return domains
}

export function clearPersistedPosthogStorage(projectToken: string): void {
    const key = `ph_${projectToken}_posthog`
    window.localStorage.removeItem(key)

    const expired = `${key}=; Max-Age=0; Path=/`
    // Host-only cookie, then every parent domain it could have been scoped to
    // (posthog-js defaults to a cross-subdomain cookie on the registrable domain).
    document.cookie = expired
    for (const domain of cookieDomains(window.location.hostname)) {
        document.cookie = `${expired}; Domain=${domain}`
    }
}
