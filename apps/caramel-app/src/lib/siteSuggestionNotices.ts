// src/lib/siteSuggestionNotices.ts
//
// The two emails a site suggestion can produce once the store becomes
// supported: the REQUESTER notice ("the store you asked for is live") and the
// OPS notice ("these domains flipped; N people are waiting to be told").
//
// Composition and sending only — this module never touches prisma. The table
// and its lifecycle stay in src/lib/siteSuggestions.ts (the one home), which
// calls in here; keeping the split means a mail change can never quietly change
// what a row says, and a row change can never quietly change what is mailed.
import StoreSupportedTemplate from '@/emails/StoreSupportedTemplate'
import { sendEmail } from '@/lib/email'
import { BASE_URL } from '@/lib/env.client'
import { render } from '@react-email/render'

/**
 * Where operator mail about site suggestions goes.
 *
 * aladdin@devino.ca, NOT support@unotes.net: the old recipient was a
 * copy-paste from another project whose mailbox bounces, so every visitor
 * suggestion was silently lost (a real one bounced 2026-08-08 06:33 UTC and had
 * to be recovered from the UseSend event log). Deliberately NOT
 * env.SUPPORT_EMAIL_TO either — the manual import flow mines THIS inbox for the
 * suggestion subject line, so the two must not drift apart on a deploy-env edit.
 *
 * One constant, because the "a store went live" notice must land in the same
 * inbox as the "someone asked for a store" notice: an operator reading one and
 * not the other cannot close the loop.
 */
export const SITE_SUGGESTION_OPS_EMAIL = 'aladdin@devino.ca'

/** The store's own page — the one link the requester notice carries. It renders
 * for any host (only an EMPTY slug 404s), so this can never be a dead link. */
export function storePageUrl(domain: string): string {
    return `${BASE_URL}/coupons/${encodeURIComponent(domain)}`
}

/** Subject line of the requester notice. Exported so the tests and the ops mail
 * can quote the real thing rather than a copy that drifts. */
export function storeSupportedSubject(domain: string): string {
    return `${domain} is now supported in Caramel`
}

/**
 * Mail ONE requester that the store they asked for is supported.
 *
 * Throws on a send failure — deliberately. The caller stamps `notified_at`
 * BEFORE calling (so two concurrent notifiers cannot both send), and it needs
 * the throw to know it must un-stamp: a swallowed failure here would leave a
 * row that says the person was told when nobody told them, and nothing would
 * ever try again.
 */
export async function sendStoreSupportedNotice(input: {
    to: string
    domain: string
}): Promise<void> {
    const { to, domain } = input
    const storeUrl = storePageUrl(domain)
    // Both body parts, always. A mail client that drops the HTML part must
    // still receive a readable message, and the URL is built once so the two
    // parts can never point at different places.
    const html = await render(StoreSupportedTemplate({ domain, storeUrl }))
    const lines = [
        `${domain} is now supported in Caramel.`,
        '',
        `You asked us to support ${domain}. It is live now, so Caramel will`,
        'find and test coupon codes for you the next time you check out there.',
        '',
        `See ${domain} codes: ${storeUrl}`,
        '',
        'Thanks for the suggestion.',
    ]
    await sendEmail({
        to,
        subject: storeSupportedSubject(domain),
        html,
        text: lines.join('\n'),
    })
}

export interface SupportedOpsNoticeInput {
    /** Domains this ack flipped to `supported`, in the order they were named. */
    domains: string[]
    /** Rows that flipped and carry a requester email. */
    requesters: number
    /** Requesters actually mailed by this ack (0 when the switch is off). */
    autoNotified: number
    /** Requesters left waiting for the owner's decision. */
    pending: number
    /** Suggestion ids of exactly those pending rows — pasted into the command
     * below so the operator never has to look one up. */
    pendingIds: string[]
    /** Sends this ack attempted and FAILED (the row was un-stamped and stays
     * pending). Reported so a failure is never invisible to the operator. */
    failed: number
}

/** Plain-text ops notice. `sendEmail` turns it into escaped, <br/>-preserving
 * HTML, so both body parts carry the same words. */
export function buildSupportedOpsNoticeText(
    input: SupportedOpsNoticeInput,
): string {
    const { domains, requesters, autoNotified, pending, pendingIds, failed } =
        input
    const lines: string[] = [
        `Marked supported: ${domains.join(', ')}`,
        '',
        `Requesters with an email: ${requesters}`,
        `Auto-notified now: ${autoNotified}`,
        `Awaiting your decision: ${pending}`,
    ]
    if (failed > 0) {
        lines.push(
            `Send FAILED (still pending, safe to retry): ${failed}`,
            'Those rows were left un-notified on purpose — the command below retries them.',
        )
    }
    if (pendingIds.length > 0) {
        lines.push(
            '',
            'To send the notice to everyone still waiting, run:',
            '',
            `  curl -X POST ${BASE_URL}/api/ingest/site-suggestions/notify \\`,
            '    -H "Authorization: Bearer $INGEST_API_KEY" \\',
            "    -H 'Content-Type: application/json' \\",
            `    -d '${JSON.stringify({ ids: pendingIds })}'`,
            '',
            'It is idempotent: a requester already told about a domain is never',
            'mailed twice, however many times the command runs.',
        )
    } else {
        lines.push('', 'Nothing is waiting — no notice to send.')
    }
    return lines.join('\n')
}

/**
 * Tell the operator what an ack just did. Throws on a send failure; the caller
 * reports it rather than failing the ack, because the status transitions are
 * the system of record and are already committed by the time this runs.
 */
export async function sendSupportedOpsNotice(
    input: SupportedOpsNoticeInput,
): Promise<void> {
    const subject =
        input.domains.length === 1
            ? `Caramel: ${input.domains[0]} marked supported`
            : `Caramel: ${input.domains.length} stores marked supported`
    await sendEmail({
        to: SITE_SUGGESTION_OPS_EMAIL,
        subject,
        text: buildSupportedOpsNoticeText(input),
    })
}
