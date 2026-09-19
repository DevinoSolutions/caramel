import { withRoute } from '@/lib/api/withRoute'
import { sendEmail } from '@/lib/email'
import {
    normalizeSuggestedDomain,
    recordSiteSuggestion,
    SiteSuggestionSourceSchema,
} from '@/lib/siteSuggestions'
import * as Sentry from '@sentry/nextjs'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// POST /api/sites/suggest — "please support this store".
//
// The row in `site_suggestions` is the SYSTEM OF RECORD (src/lib/siteSuggestions.ts):
// it is what the coupons pipeline drains through GET /api/ingest/site-suggestions
// and what lets an operator answer the requester once the store is supported.
// The ops email is a NOTIFICATION on top of it, so it is sent AFTER the write
// and its failure is reported to Sentry rather than turning a persisted
// suggestion into a 500 the visitor would read as "not sent".
//
// Identity, in order of trust: a better-auth session (auth: 'optional' —
// resolve, never gate; the form lives on a public page) supplies user id +
// email and OVERRIDES anything in the body; otherwise the OPTIONAL body
// `email` is recorded so an anonymous visitor can still be told. Neither is
// ever required.
//
// Strict — previously had NEITHER a rate limit NOR an origin gate despite
// sending mail on every call (PLAN-F-007.md's flagged gap). `url` missing
// now 422s instead of the old manual 400 "Missing url" (§Breaking).
const SuggestBodySchema = z.object({
    url: z.string().trim().min(1).max(2048),
    // Optional contact for an anonymous requester. Ignored when a session
    // supplies the email (the session wins — client identity is never trusted).
    email: z.string().trim().email().max(320).optional(),
    // Defaults to 'web' because the /supported-stores form is the only caller
    // today; the extension may name itself when it grows a suggest form.
    source: SiteSuggestionSourceSchema.default('web'),
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'sites/suggest',
        rateLimit: 'mutation',
        origin: true,
        auth: 'optional',
        body: SuggestBodySchema,
    },
    async ({ req, body, session }) => {
        const domain = normalizeSuggestedDomain(body.url)
        if (!domain) {
            // Not a store (a bare public suffix, localhost, garbage). Nothing
            // to record, nothing to mail — the pipeline cannot act on it.
            return NextResponse.json(
                { error: 'Please enter a store URL (e.g. https://store.com)' },
                { status: 400 },
            )
        }

        const userId = session?.user?.id ?? null
        const requesterEmail = session?.user?.email ?? body.email ?? null
        const { id } = await recordSiteSuggestion({
            domain,
            rawUrl: body.url,
            userId,
            requesterEmail,
            source: body.source,
            userAgent: req.headers.get('user-agent')?.slice(0, 512) ?? null,
        })

        // The requester line is what the manual flow reads today: an operator
        // mining this inbox can reply the moment the store goes live.
        const requester = requesterEmail
            ? `${requesterEmail}${userId ? ` (user ${userId})` : ''}`
            : 'anonymous'
        let notified = true
        try {
            // First line kept VERBATIM ("A user suggested a new site: <url>") —
            // the coupons repo's manual import mines this mail by that phrase.
            // aladdin@devino.ca, NOT support@unotes.net: the old recipient was
            // a copy-paste from another project whose mailbox bounces, so every
            // visitor suggestion was silently lost (a real one bounced
            // 2026-08-08 06:33 UTC and had to be recovered from the UseSend
            // event log). Deliberately NOT SUPPORT_EMAIL_TO: the pipeline's
            // manual import mines THIS inbox for the subject line.
            await sendEmail({
                to: 'aladdin@devino.ca',
                subject: 'Caramel Site Suggestion',
                text: [
                    `A user suggested a new site: ${body.url}`,
                    `Domain: ${domain}`,
                    `Requested by: ${requester}`,
                    `Source: ${body.source}`,
                    `Suggestion id: ${id}`,
                ].join('\n'),
            })
        } catch (error) {
            // The suggestion IS saved; only the notification failed. Loud
            // (Sentry, with the id so the row can be found) but not a 500.
            notified = false
            Sentry.captureException(error, {
                tags: {
                    operation: 'site_suggestion_email',
                    route: 'sites/suggest',
                },
                extra: { suggestionId: id, domain },
            })
        }
        return NextResponse.json({ ok: true, id, notified })
    },
)
