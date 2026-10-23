// src/lib/siteSuggestionIntake.ts
//
// The anonymous-intake bounds for POST /api/sites/suggest (T-6224): what the
// route checks BEFORE it writes a `site_suggestions` row or mails the ops
// inbox. The route is reachable with no account, no Origin header and only the
// per-IP 'mutation' bucket (30/min), so without these a single caller could
// insert and mail ~1,800 rows an hour, and rotating IPs scaled that linearly.
//
// Everything is derived from the table itself (no new column, no migration, no
// extra store), so the limits are durable across restarts and shared by every
// instance.
//
// TODO(T-6224): still open, deliberately not in this PR - (1) Turnstile/captcha
// for anonymous callers; (2) double opt-in of the anonymous body email before
// ingest/site-suggestions/notify mails it (that route is operator-triggered with
// the ingest bearer and SITE_SUGGESTIONS_AUTO_NOTIFY is off by default, so the
// "email any third party" path needs a human today, but the address is still
// unverified); (3) batching the ops mail into a digest instead of dropping it
// over budget (the row is the system of record, so nothing is lost).
import prisma from '@/lib/prisma'
import { foldRequesterEmail } from '@/lib/siteSuggestionIdentity'
import * as Sentry from '@sentry/nextjs'

/** One window for all three bounds: the same (domain, requester) inside it is
 * ONE suggestion, and both global budgets count rows created inside it. */
const DAY_MS = 24 * 60 * 60 * 1000

/** Rows accepted per rolling 24h across ALL callers; over it the route answers 429. */
export const SUGGESTION_ROWS_PER_DAY_CAP = 1000
/** Ops mails per rolling 24h across ALL callers; over it the row is still saved, the mail is not sent. */
export const SUGGESTION_OPS_MAILS_PER_DAY_BUDGET = 40

export type SuggestionIntake =
    | { kind: 'duplicate'; id: string }
    | { kind: 'over_daily_cap' }
    | { kind: 'accept'; sendOpsMail: boolean }

/** Any control character (C0/C1) or line/paragraph separator. The
 * URL and email go into a plain-text mail one-per-line; WHATWG URL parsing
 * silently drops tab/CR/LF, so a value carrying one still validates as a store
 * URL while forging extra lines in that mail. Such input is refused outright. */
export const CONTROL_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u

export async function assessSuggestionIntake(input: {
    domain: string
    userId: string | null
    requesterEmail: string | null
    now?: Date
}): Promise<SuggestionIntake> {
    const since = new Date((input.now ?? new Date()).getTime() - DAY_MS)
    const identity =
        input.requesterEmail !== null
            ? { requesterEmail: foldRequesterEmail(input.requesterEmail) }
            : { requesterEmail: null, userId: input.userId }
    const existing = await prisma.siteSuggestion.findFirst({
        where: { domain: input.domain, createdAt: { gte: since }, ...identity },
        select: { id: true },
    })
    if (existing) return { kind: 'duplicate', id: existing.id }

    const recent = await prisma.siteSuggestion.count({
        where: { createdAt: { gte: since } },
    })
    if (recent >= SUGGESTION_ROWS_PER_DAY_CAP) return { kind: 'over_daily_cap' }
    if (recent === SUGGESTION_OPS_MAILS_PER_DAY_BUDGET) {
        // Said once, on the request that crosses the line, so ops learns the
        // mail stopped without every later request adding an event.
        Sentry.captureMessage(
            'Site suggestion ops-mail daily budget reached; further suggestions are saved but not mailed',
            {
                level: 'warning',
                tags: { operation: 'site_suggestion_mail_budget' },
                extra: { budget: SUGGESTION_OPS_MAILS_PER_DAY_BUDGET },
            },
        )
    }
    return {
        kind: 'accept',
        sendOpsMail: recent < SUGGESTION_OPS_MAILS_PER_DAY_BUDGET,
    }
}
