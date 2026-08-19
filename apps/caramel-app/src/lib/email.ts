import { env } from '@/lib/env'
import { UseSend } from 'usesend-js'

type EmailPayload = {
    to: string | string[]
    subject: string
    html?: string
    text?: string
    /** Address the recipient's reply should go to (usesend `replyTo`). NEVER
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
    const apiKey = env.USESEND_API_KEY
    if (!apiKey) {
        throw new Error(
            'USESEND_API_KEY is not defined in environment variables',
        )
    }
    return new UseSend(apiKey)
}

export const sendEmail = async (data: EmailPayload) => {
    const fromEmail = env.USESEND_FROM_EMAIL
    const fromName = env.USESEND_FROM_NAME

    const client = getClient()
    const result = await client.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: data.to,
        subject: data.subject,
        // A text-only caller gets ESCAPED, <br/>-preserving HTML — never its
        // raw newline-formatted text dropped into the HTML body. See textToHtml.
        html: data.html || (data.text ? textToHtml(data.text) : ''),
        text: data.text,
        // Only set replyTo when provided — usesend treats an absent field
        // differently from an empty string.
        ...(data.replyTo ? { replyTo: data.replyTo } : {}),
    })

    if (result?.error) {
        const raw = result.error as Record<string, unknown>
        const nested = (raw.error ?? raw) as Record<string, unknown>
        const msg = nested.message || JSON.stringify(result.error)
        const code = nested.code || 'UNKNOWN'
        throw new Error(`useSend email failed: ${msg} (${code})`)
    }
}
