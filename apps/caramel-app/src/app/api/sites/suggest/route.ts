import { sendEmail } from '@/lib/email'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
    const { url = '' } = (await req.json().catch(() => ({}))) as {
        url?: string
    }
    const cleaned = url.trim()
    if (!cleaned)
        return NextResponse.json({ error: 'Missing url' }, { status: 400 })
    try {
        await sendEmail({
            to: 'support@unotes.net',
            subject: 'Caramel Site Suggestion',
            text: `A user suggested a new site: ${cleaned}`,
        })
        return NextResponse.json({ ok: true })
    } catch {
        return NextResponse.json(
            { error: 'Could not save suggestion' },
            { status: 500 },
        )
    }
}
