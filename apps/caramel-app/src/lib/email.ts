import { env } from '@/lib/env'
import { UseSend } from 'usesend-js'

type EmailPayload = {
    to: string
    subject: string
    html?: string
    text?: string
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
        html: data.html || data.text || '',
    })

    if (result?.error) {
        const raw = result.error as Record<string, unknown>
        const nested = (raw.error ?? raw) as Record<string, unknown>
        const msg = nested.message || JSON.stringify(result.error)
        const code = nested.code || 'UNKNOWN'
        throw new Error(`useSend email failed: ${msg} (${code})`)
    }
}
