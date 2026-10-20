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
 * Send email through Sendly — the only email transport in this app (useSend and
 * Resend are retired).
 *
 * Throws on ANY failure — a missing key, a rejected request, a transport error
 * — with a message naming the Sendly status/code/requestId, so every caller's
 * Sentry capture is actionable. Nothing here swallows an error.
 *
 * Sendly's send takes ONE recipient per request (`cc`/`bcc` copy others), so an
 * array `to` is fanned out as one send per recipient. ALL are attempted, and
 * one error naming every failed recipient index is thrown if any failed.
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

    const rejections = outcomes.flatMap((outcome, index) =>
        outcome.status === 'rejected'
            ? [{ index, reason: outcome.reason as unknown }]
            : [],
    )
    if (rejections.length > 0) {
        const detail = rejections
            .map(
                ({ index, reason }) =>
                    `recipient ${index + 1}/${recipients.length}: ${describeSendlyFailure(reason)}`,
            )
            .join('; ')
        // tsconfig's lib predates ErrorOptions, so the first underlying
        // SendlyError is attached as `cause` by hand for Sentry's chain view.
        throw Object.assign(new Error(`Sendly email failed — ${detail}`), {
            cause: rejections[0]!.reason,
        })
    }
}
