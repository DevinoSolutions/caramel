import { EMAIL_FAILURE_STATUSES } from '@/lib/emailDeliveryHealth'
import { env } from '@/lib/env'
import { Sendly, SendlyError } from 'sendly-sdk'

type EmailPayload = {
    to: string | string[]
    subject: string
    html?: string
    /** Plain-text source. Sendly's send API takes ONE body (HTML) and has no
     * separate text part: a text-only caller is rendered to escaped HTML via
     * textToHtml; a caller passing BOTH gets its `html` sent and the text is
     * not transmitted. */
    text?: string
    /** Address the recipient's reply should go to (Sendly `reply`). NEVER
     * the sender/`from` — that stays the verified Caramel domain. Used by the
     * support flow to route a customer reply back to them. */
    replyTo?: string
}

/**
 * Split a comma-separated recipient env value into clean addresses.
 *
 * The support inbox is configured as ONE env var that may hold several
 * addresses (`a@x.com,b@y.com`) so adding a teammate is a deploy-env edit, not
 * a code change. Whitespace around commas is tolerated and empty segments are
 * dropped, so a trailing comma cannot mail a blank recipient.
 */
export const parseRecipientList = (raw: string): string[] =>
    raw
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)

/** HTML-escape every character that could change the shape of the markup. */
const escapeHtml = (value: string) =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')

/**
 * Minimal HTML for a caller that only has plain text.
 *
 * Sending the raw text as the HTML body — which this module used to do — is
 * what made the support notification arrive malformed: HTML collapses newlines,
 * so a carefully line-formatted report rendered as one unstyled run-on wall
 * (measured on the real production message, whose `html` and `text` fields were
 * byte-identical). It is also an injection hole, because the support message is
 * user input: `<script>` typed into the form would have been markup in the
 * operator's inbox, not text.
 *
 * So the text is escaped first and its line breaks become real <br/>, inside a
 * readable system-font wrapper. A caller with a designed template passes `html`
 * and never reaches this.
 */
export const textToHtml = (value: string) => {
    const body = escapeHtml(value).replace(/\r?\n/g, '<br />')
    return (
        "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto," +
        "'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:24px;color:#1a1a2e;" +
        'max-width:600px;margin:0 auto;padding:16px;">' +
        body +
        '</div>'
    )
}

const getClient = () => {
    const apiKey = env.SENDLY_API_KEY
    if (!apiKey) {
        throw new Error(
            'SENDLY_API_KEY is not defined in environment variables',
        )
    }
    return new Sendly({
        apiKey,
        ...(env.SENDLY_BASE_URL ? { baseUrl: env.SENDLY_BASE_URL } : {}),
    })
}

/**
 * Sentry/log-usable description of a failed Sendly call: HTTP status, the
 * stable machine code and Sendly's requestId (quote it in support requests).
 * Never the recipient address or the body.
 */
const describeSendlyFailure = (error: unknown): string => {
    if (error instanceof SendlyError) {
        const requestId = error.requestId
            ? `, requestId=${error.requestId}`
            : ''
        return `${error.message} (status=${error.statusCode}, code=${error.errorCode}${requestId})`
    }
    return error instanceof Error ? error.message : String(error)
}

/**
 * Receipt statuses that mean this message will NOT be delivered. A 202 receipt
 * is normally PENDING, but the API may already answer with a terminal state
 * (a rejected or unrenderable message); resolving the promise is not success.
 * CANCELLED joins the delivery-health failure set here because a send we
 * just requested and the provider already cancelled is lost mail.
 */
const RECEIPT_FAILURE_STATUSES: ReadonlySet<string> = new Set([
    ...EMAIL_FAILURE_STATUSES,
    'CANCELLED',
])

/**
 * Describe what is wrong with a resolved receipt, or null when it is fine.
 * Carries the receipt id + status only - never the recipient.
 */
const describeReceiptProblem = (receipt: unknown): string | null => {
    const { id, status } = (receipt ?? {}) as {
        id?: unknown
        status?: unknown
    }
    if (typeof id !== 'string' || typeof status !== 'string') {
        return 'Sendly returned a receipt without an id/status (cannot confirm acceptance)'
    }
    if (RECEIPT_FAILURE_STATUSES.has(status)) {
        return `receipt ${id} came back with terminal status ${status}`
    }
    return null
}

/**
 * Send email through Sendly — the only email transport in this app (useSend and
 * Resend are retired).
 *
 * Throws on ANY failure — a missing key, a rejected request, a transport error,
 * or a receipt that already carries a terminal failure status (FAILED, BOUNCED,
 * REJECTED, RENDERING_FAILURE, CANCELLED) — with a message naming the Sendly
 * status/code/requestId or receipt id + status, so every caller's Sentry
 * capture is actionable. Nothing here swallows an error. (A later async
 * bounce is NOT visible here; emailDeliveryHealth.ts covers that.)
 *
 * Sendly's send takes ONE recipient per request (`cc`/`bcc` copy others), so an
 * array `to` is fanned out as one send per recipient. ALL are attempted, and
 * one error naming every failed recipient index is thrown if any failed - a
 * partial fan-out failure (some delivered-looking, some not) still throws.
 * Separate sends (rather than `cc`) keep recipients from seeing each other.
 */
export const sendEmail = async (data: EmailPayload): Promise<void> => {
    const client = getClient()
    const recipients = Array.isArray(data.to) ? data.to : [data.to]
    if (recipients.length === 0) {
        throw new Error('Sendly email failed: no recipients (empty `to`)')
    }

    // A text-only caller gets ESCAPED, <br/>-preserving HTML — never its raw
    // newline-formatted text dropped into the HTML body. See textToHtml.
    const body = data.html || (data.text ? textToHtml(data.text) : '')

    const outcomes = await Promise.allSettled(
        recipients.map(to =>
            client.emails.send({
                from: {
                    email: env.SENDLY_FROM_EMAIL,
                    name: env.SENDLY_FROM_NAME,
                },
                to,
                subject: data.subject,
                body,
                // Only set `reply` when provided; the sender stays the
                // verified Caramel address either way.
                ...(data.replyTo ? { reply: data.replyTo } : {}),
            }),
        ),
    )

    const failures = outcomes.flatMap((outcome, index) => {
        if (outcome.status === 'rejected') {
            return [
                {
                    index,
                    message: describeSendlyFailure(outcome.reason),
                    cause: outcome.reason as unknown,
                },
            ]
        }
        const problem = describeReceiptProblem(outcome.value)
        return problem === null
            ? []
            : [{ index, message: problem, cause: undefined }]
    })
    if (failures.length > 0) {
        const detail = failures
            .map(
                ({ index, message }) =>
                    `recipient ${index + 1}/${recipients.length}: ${message}`,
            )
            .join('; ')
        // tsconfig's lib predates ErrorOptions, so the first underlying
        // SendlyError (when there is one) is attached as `cause` by hand for
        // Sentry's chain view.
        throw Object.assign(new Error(`Sendly email failed — ${detail}`), {
            cause: failures.find(failure => failure.cause !== undefined)?.cause,
        })
    }
}
