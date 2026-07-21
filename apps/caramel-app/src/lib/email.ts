import { env } from '@/lib/env'
import { UseSend } from 'usesend-js'

type EmailPayload = {
    to: string
    subject: string
    html?: string
    text?: string
    /** Address the recipient's reply should go to (usesend `replyTo`). NEVER
     * the sender/`from` — that stays the verified Caramel domain. Used by the
     * support flow to route a customer reply back to them. */
    replyTo?: string
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
        // Keep the pre-existing text→html fold so text-only callers
        // (sites/suggest) still render, but ALSO send a real text part now.
        html: data.html || data.text || '',
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
