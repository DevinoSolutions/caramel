// Operator-facing PostHog deep links.
//
// The support email carries a feedback_id and, until now, no way to jump to
// the matching `support_request_submitted` event — the template deliberately
// refused to guess a URL because no env carried the project id (a link that
// 404s is worse than an id the operator can paste). POSTHOG_PROJECT_UI_URL
// (env.ts) closes that gap: it names the browser UI of THIS deploy's PostHog
// project, so the link below is constructed, never guessed.
//
// The `#q=` payload is PostHog's activity-explorer query fragment. This exact
// shape (DataTableNode → EventsQuery, `exact` operator on the event property)
// was proven against the live self-hosted instance on 2026-08-19: navigating
// it renders the explorer with the `feedback_id = …` filter chip applied and
// exactly the one matching event row. Change the shape only by re-proving it
// in a browser first.

/**
 * Deep link to the activity explorer filtered to ONE support submission's
 * `support_request_submitted` event, or undefined when no project UI URL is
 * configured (the email then simply carries no link).
 *
 * @param feedbackId the submission's client-generated correlation id
 * @param projectUiUrl env.POSTHOG_PROJECT_UI_URL — e.g.
 *   "https://posthog.example.com/project/123" (trailing slashes tolerated)
 */
export function posthogSupportEventUrl(
    feedbackId: string,
    projectUiUrl: string | undefined,
): string | undefined {
    if (!projectUiUrl) return undefined
    const query = {
        kind: 'DataTableNode',
        full: true,
        source: {
            kind: 'EventsQuery',
            select: ['*', 'event', 'person', 'timestamp'],
            event: 'support_request_submitted',
            properties: [
                {
                    key: 'feedback_id',
                    value: [feedbackId],
                    operator: 'exact',
                    type: 'event',
                },
            ],
            // The explorer defaults to a 24h window; a support email may be
            // triaged days later, so widen the window past any realistic lag.
            after: '-90d',
        },
    }
    const base = projectUiUrl.replace(/\/+$/, '')
    return `${base}/activity/explore#q=${encodeURIComponent(JSON.stringify(query))}`
}
