// src/app/api/support/route.ts
//
// The user support/feedback flow's server endpoint. PUBLIC (an anonymous user
// must be able to report a login problem without authenticating), rate-limited
// as a mutation, origin-gated. It fans the submission out to TWO independent
// destinations — a PostHog `support_request_submitted` event and an email to
// the support inbox — and reports each leg's outcome honestly (partial-failure
// matrix). Nothing is ever silently discarded: on a total failure the 502 body
// echoes the client-generated feedback_id so the client can keep its form
// state and retry with the SAME id.
//
// NOTE: there is no PostHog *survey* configured for caramel, so we deliberately
// capture a first-class `support_request_submitted` event instead of survey
// responses. If a survey is created later, a `POSTHOG_SUPPORT_SURVEY_ID` env
// var could route submissions to it — do NOT invent an id before one exists.
import SupportNotificationTemplate from '@/emails/SupportNotificationTemplate'
import { APP_ID } from '@/lib/analytics/posthogDataset'
import { captureServerEvent } from '@/lib/analytics/posthogServer'
import { withRoute } from '@/lib/api/withRoute'
import { auth } from '@/lib/auth/auth'
import { parseRecipientList, sendEmail } from '@/lib/email'
import { env } from '@/lib/env'
import { APP_VERSION } from '@/lib/env.client'
import { render } from '@react-email/render'
import * as Sentry from '@sentry/nextjs'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const SupportBodySchema = z
    .object({
        // Client-generated correlation id — the SAME id flows to both
        // destinations, and is echoed back on total failure for retry.
        feedback_id: z.string().uuid(),
        feedback_type: z.enum([
            'problem',
            'feature_request',
            'question',
            'other',
        ]),
        message: z.string().trim().min(1).max(4000),
        expected_outcome: z.string().trim().max(2000).optional(),
        wants_reply: z.boolean(),
        // For anonymous users who want a reply. Overridden by the session email
        // when a session exists (see the handler) — never trusted for auth.
        email: z.string().email().max(320).optional(),
        // Correlation metadata ONLY — never used for authentication.
        posthog_session_id: z.string().max(200).optional(),
        posthog_distinct_id: z.string().max(200).optional(),
        // Present when the form was opened from an error prompt.
        sentry_event_id: z.string().max(64).optional(),
        // The page the user was on.
        route: z.string().max(500).optional(),
        // E2E-ONLY correlation metadata: the shared Playwright handshake's
        // test_run_id / test_scenario, forwarded by the browser ONLY when
        // window.__CARAMEL_E2E__ is present (real production submissions never
        // carry these). test_run_id is a browser super-property, so without
        // this it would never reach a SERVER-captured event — forwarding it
        // lets the e2e ingestion-verification helper find THIS run's
        // support_request_submitted event by test_run_id. Never used for auth
        // or any behavioural branch.
        test_run_id: z.string().max(200).optional(),
        test_scenario: z.string().max(200).optional(),
        // HONEYPOT: a hidden field no real user ever fills. Non-empty ⇒ bot.
        website: z.string().optional(),
    })
    .superRefine((data, ctx) => {
        // Wanting a reply requires SOME reply address. A logged-in client sends
        // its known account email here too (the UI doesn't re-ask), so this
        // fires only for the genuinely-anonymous "reply me, but no email" case
        // → 422 via withRoute's body gate.
        if (data.wants_reply && !data.email) {
            ctx.addIssue({
                code: 'custom',
                path: ['email'],
                message: 'email is required when wants_reply is true',
            })
        }
    })

type SupportBody = z.infer<typeof SupportBodySchema>

/** The Sentry issue-search URL for an event id, or undefined when there is none.
 *
 * Org slug 'devino' is the real, known Sentry org (next.config.mjs). Shared by
 * both body parts so the text and the HTML can never link to different places.
 */
function sentryIssueUrl(sentryEventId: string | undefined): string | undefined {
    if (!sentryEventId) return undefined
    return `https://devino.sentry.io/organizations/devino/issues/?query=${encodeURIComponent(
        sentryEventId,
    )}`
}

/** Plain-text support email body — every field an operator needs to triage. */
function buildEmailText(input: {
    body: SupportBody
    userId: string | undefined
    environment: string
}): string {
    const { body, userId, environment } = input
    const lines: string[] = [
        `Feedback ID: ${body.feedback_id}`,
        `Type: ${body.feedback_type}`,
        `Wants reply: ${body.wants_reply ? 'yes' : 'no'}`,
        '',
        'Message:',
        body.message,
        '',
        'Expected outcome:',
        body.expected_outcome ?? '(none provided)',
        '',
        '--- context ---',
        `App: ${APP_ID} v${APP_VERSION}`,
        `Environment: ${environment}`,
        `Platform: web`,
        `Route: ${body.route ?? '(unknown)'}`,
        `User: ${userId ?? 'anonymous'}`,
        `PostHog session: ${body.posthog_session_id ?? '(none)'}`,
        `PostHog distinct id: ${body.posthog_distinct_id ?? '(none)'}`,
    ]
    const sentryUrl = sentryIssueUrl(body.sentry_event_id)
    if (body.sentry_event_id && sentryUrl) {
        lines.push(`Sentry event id: ${body.sentry_event_id}`)
        lines.push(`Sentry: ${sentryUrl}`)
    }
    return lines.join('\n')
}

/** The HTML part — the same fields, structured, on the shared Caramel layout.
 *
 * Deliberately NOT given a PostHog replay link: a replay URL needs the project
 * id, and no env in this app carries one (only the E2E test project has an id,
 * and that is a different project). The session and distinct ids are rendered
 * as selectable text instead — a guessed URL that 404s is worse than an id the
 * operator can paste.
 */
async function buildEmailHtml(input: {
    body: SupportBody
    userId: string | undefined
    environment: string
}): Promise<string> {
    const { body, userId, environment } = input
    return render(
        SupportNotificationTemplate({
            feedbackId: body.feedback_id,
            feedbackType: body.feedback_type,
            wantsReply: body.wants_reply,
            message: body.message,
            expectedOutcome: body.expected_outcome,
            appLabel: `${APP_ID} v${APP_VERSION}`,
            environment,
            platform: 'web',
            route: body.route ?? '(unknown)',
            userLabel: userId ?? 'anonymous',
            posthogSessionId: body.posthog_session_id,
            posthogDistinctId: body.posthog_distinct_id,
            sentryEventId: body.sentry_event_id,
            sentryUrl: sentryIssueUrl(body.sentry_event_id),
        }),
    )
}

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'support',
        rateLimit: 'mutation',
        origin: true,
        body: SupportBodySchema,
    },
    async ({ req, body }) => {
        // HONEYPOT short-circuit: a non-empty hidden `website` field ⇒ a bot.
        // Return a normal-looking 200 WITHOUT sending anything (no email, no
        // support event). Best-effort analytics only — a bot submission is not
        // a Sentry-worthy error, so it is never captured as one.
        if (body.website && body.website.trim().length > 0) {
            void captureServerEvent({
                event: 'support_honeypot_triggered',
                distinctId:
                    body.posthog_distinct_id ?? `anon:${body.feedback_id}`,
                properties: {
                    feedback_id: body.feedback_id,
                    app_id: APP_ID,
                    route: body.route ?? null,
                },
            })
            return NextResponse.json({ ok: true })
        }

        try {
            // A session ALWAYS overrides client-supplied identity for the
            // user_id + reply email — client identity is never trusted.
            const session = await auth.api.getSession({ headers: req.headers })
            const userId = session?.user?.id
            const replyEmail = session?.user?.email ?? body.email

            const hasExpectedOutcome = Boolean(
                body.expected_outcome && body.expected_outcome.length > 0,
            )
            const environment = process.env.NODE_ENV ?? 'unknown'

            // One shared property bag — the message text IS the point of the
            // event, so it (and expected_outcome) go to PostHog too. The schema
            // carries no password/token/secret-shaped fields by design.
            const properties: Record<string, unknown> = {
                feedback_id: body.feedback_id,
                feedback_source: 'support_form',
                feedback_type: body.feedback_type,
                app_id: APP_ID,
                route: body.route ?? null,
                user_id: userId ?? null,
                posthog_session_id: body.posthog_session_id ?? null,
                posthog_distinct_id: body.posthog_distinct_id ?? null,
                sentry_event_id: body.sentry_event_id ?? null,
                wants_reply: body.wants_reply,
                has_expected_outcome: hasExpectedOutcome,
                message: body.message,
                expected_outcome: body.expected_outcome ?? null,
                // E2E correlation only — null for every real submission.
                test_run_id: body.test_run_id ?? null,
                test_scenario: body.test_scenario ?? null,
            }

            const distinctId =
                userId ?? body.posthog_distinct_id ?? `anon:${body.feedback_id}`

            // May be several operators: the env value is a comma-separated
            // list, and every address gets the same notification.
            const supportRecipients = parseRecipientList(env.SUPPORT_EMAIL_TO)

            const analyticsPromise = captureServerEvent({
                event: 'support_request_submitted',
                distinctId,
                properties,
            })

            const emailPromise: Promise<'ok' | 'skipped'> = (async () => {
                if (!supportRecipients.length) return 'skipped'
                await sendEmail({
                    to: supportRecipients,
                    subject: `[Caramel support] ${body.feedback_type} — ${body.feedback_id}`,
                    // Both parts, from the same submission: the designed HTML
                    // the operator reads, and the plain text as the real text
                    // alternative (it used to be BOTH, which is the bug).
                    html: await buildEmailHtml({ body, userId, environment }),
                    text: buildEmailText({ body, userId, environment }),
                    // replyTo = the customer, ONLY when they want a reply; never
                    // the from/sender.
                    ...(body.wants_reply && replyEmail
                        ? { replyTo: replyEmail }
                        : {}),
                })
                return 'ok'
            })()

            const [analyticsSettled, emailSettled] = await Promise.allSettled([
                analyticsPromise,
                emailPromise,
            ])

            const analyticsOk =
                analyticsSettled.status === 'fulfilled' &&
                analyticsSettled.value === true
            const emailStatus: 'ok' | 'failed' | 'skipped' =
                emailSettled.status === 'fulfilled'
                    ? emailSettled.value
                    : 'failed'
            // 'skipped' (no inbox configured) counts as OK for the matrix — but
            // the client copy never promises a reply in that case.
            const emailOk = emailStatus === 'ok' || emailStatus === 'skipped'
            const analyticsStatus: 'ok' | 'failed' = analyticsOk
                ? 'ok'
                : 'failed'

            // The email leg's error is caught by allSettled and NOT
            // auto-reported (captureServerEvent already reports the analytics
            // leg internally), so surface it here with the feedback_id.
            if (emailSettled.status === 'rejected') {
                Sentry.captureException(emailSettled.reason, {
                    tags: { operation: 'support_email', route: 'support' },
                    contexts: { support: { feedback_id: body.feedback_id } },
                })
            }

            // Both failed → the only non-200: echo feedback_id so the client
            // keeps its form state and retries with the same id.
            if (!analyticsOk && !emailOk) {
                return NextResponse.json(
                    {
                        ok: false,
                        analytics: analyticsStatus,
                        email: emailStatus,
                        feedback_id: body.feedback_id,
                    },
                    { status: 502 },
                )
            }

            return NextResponse.json({
                ok: true,
                analytics: analyticsStatus,
                email: emailStatus,
            })
        } catch (error) {
            // A processing failure (e.g. session resolution) before either leg
            // ran — capture WITH the feedback_id and 502 so nothing is silently
            // dropped and the client can retry.
            Sentry.captureException(error, {
                tags: { operation: 'support_processing', route: 'support' },
                contexts: { support: { feedback_id: body.feedback_id } },
            })
            return NextResponse.json(
                {
                    ok: false,
                    analytics: 'failed',
                    email: 'failed',
                    feedback_id: body.feedback_id,
                },
                { status: 502 },
            )
        }
    },
)
