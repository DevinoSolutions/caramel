// Operator-facing Sentry deep links.
//
// Caramel reports to the SELF-HOSTED Sentry (next.config.mjs: sentryUrl
// https://sentry.devino.ca, org 'devino'). The support email used to link to
// devino.sentry.io, Sentry's SaaS, where Caramel has no org, so the link never
// reached the event.

const SENTRY_BASE_URL = 'https://sentry.devino.ca'
const SENTRY_ORG_SLUG = 'devino'

/**
 * Issue search filtered to one Sentry event id, or undefined when there is
 * none (the support email then simply carries no Sentry link).
 */
export function sentryIssueSearchUrl(
    sentryEventId: string | undefined,
): string | undefined {
    if (!sentryEventId) return undefined
    return `${SENTRY_BASE_URL}/organizations/${SENTRY_ORG_SLUG}/issues/?query=${encodeURIComponent(
        sentryEventId,
    )}`
}
