import { consumeAnonymousWriteQuota } from '@/lib/anonymousWriteQuota'
import { withRoute } from '@/lib/api/withRoute'
import { sendEmail } from '@/lib/email'
import {
    assessSuggestionIntake,
    hasControlCharacter,
} from '@/lib/siteSuggestionIntake'
import { SITE_SUGGESTION_OPS_EMAIL } from '@/lib/siteSuggestionNotices'
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
//
// T-6224: `url` and `email` are interpolated into a plain-text mail one value
// per line, and WHATWG URL parsing drops tab/CR/LF before validating, so a url
// like "https://store.com/a<LF>Domain: evil.com" passed as a store while
// forging extra lines in that mail. A control character in either is refused
// (422), not stripped: no real URL or address contains one once trimmed.
const SuggestBodySchema = z.object({
    url: z
        .string()
        .trim()
        .min(1)
        .max(2048)
        .refine(value => !hasControlCharacter(value), {
            message: 'must not contain control characters',
        }),
    // Optional contact for an anonymous requester. Ignored when a session
    // supplies the email (the session wins — client identity is never trusted).
    email: z
        .string()
        .trim()
        .email()
        .max(320)
        .refine(value => !hasControlCharacter(value), {
            message: 'must not contain control characters',
        })
        .optional(),
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

        // T-6224: one address cannot spend the shared daily budgets below.
        const quota = await consumeAnonymousWriteQuota(req, 'sites/suggest')
        if (!quota.allowed) {
            return NextResponse.json(
                {
                    error: 'You have sent a lot of store requests. Please try again later.',
                },
                {
                    status: 429,
                    headers: { 'Retry-After': String(quota.retryAfterSec) },
                },
            )
        }

        const userId = session?.user?.id ?? null
        const requesterEmail = session?.user?.email ?? body.email ?? null

        // T-6224: anonymous-intake bounds (siteSuggestionIntake.ts). The same
        // requester asking for the same store inside a day is ONE suggestion:
        // answered ok, but no new row and no new mail. The body carries no id
        // and no flag, so it does not confirm to a stranger that a given email
        // asked for a given store.
        const intake = await assessSuggestionIntake({
            domain,
            userId,
            requesterEmail,
        })
        if (intake.kind === 'duplicate') {
            return NextResponse.json({ ok: true, notified: false })
        }
        if (intake.kind === 'over_daily_cap') {
            return NextResponse.json(
                {
                    error: 'We have received a lot of store requests today. Please try again tomorrow.',
                },
                { status: 429, headers: { 'Retry-After': '3600' } },
            )
        }
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
        // Over the daily mail budget the row above is still the record; only
        // the ops mail is withheld (the budget crossing is reported to Sentry
        // once, in assessSuggestionIntake).
        if (!intake.sendOpsMail) {
            return NextResponse.json({ ok: true, id, notified: false })
        }
        let notified = true
        try {
            // First line kept VERBATIM ("A user suggested a new site: <url>") —
            // the coupons repo's manual import mines this mail by that phrase.
            // ONE constant for the ops inbox (siteSuggestionNotices.ts), which
            // also carries the reasons it is neither support@unotes.net nor
            // SUPPORT_EMAIL_TO. Shared with the "store went live" notice on
            // purpose: an operator who reads one of the two and not the other
            // cannot close the loop on a request.
            await sendEmail({
                to: SITE_SUGGESTION_OPS_EMAIL,
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
            // Also logged: the Sentry send can fail for the same reason the
            // mail did, and the first suggestion after the 2026-09-26 01:10Z
            // deploy failed with no Sentry event and no log line at all.
            notified = false
            console.error(
                `[sites/suggest] ops email failed for suggestion ${id} (${domain}):`,
                error,
            )
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
