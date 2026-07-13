import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { sendEmail } from '@/lib/email'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// Strict — previously had NEITHER a rate limit NOR an origin gate despite
// sending mail on every call (PLAN-F-007.md's flagged gap). `url` missing
// now 422s instead of the old manual 400 "Missing url" (§Breaking).
const SuggestBodySchema = z.object({
    url: z.string().trim().min(1),
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'sites/suggest',
        rateLimit: 'mutation',
        origin: true,
        body: SuggestBodySchema,
    },
    async ({ req, body }) => {
        const cleaned = body.url
        try {
            await sendEmail({
                to: 'support@unotes.net',
                subject: 'Caramel Site Suggestion',
                text: `A user suggested a new site: ${cleaned}`,
            })
            return NextResponse.json({ ok: true })
        } catch (error) {
            return handleRouteError(error, {
                req,
                message: 'Could not save suggestion',
            })
        }
    },
)
