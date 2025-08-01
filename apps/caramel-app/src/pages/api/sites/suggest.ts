import { sendEmail } from '@/lib/email'
import { NextApiRequest, NextApiResponse } from 'next'

interface SuggestSiteBody {
    url?: string
}

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse,
) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST'])
        return res.status(405).end(`Method ${req.method} Not Allowed`)
    }

    const { url = '' }: SuggestSiteBody = req.body || {}
    const cleaned = url.trim()
    if (!cleaned) return res.status(400).json({ error: 'Missing url' })

    try {
        await sendEmail({
            to: 'support@unotes.net',
            subject: 'Caramel Site Suggestion',
            text: `A user suggested a new site: ${cleaned}`,
        })
        return res.status(200).json({ ok: true })
    } catch (err) {
        console.error(err)
        return res.status(500).json({ error: 'Could not save suggestion' })
    }
}
