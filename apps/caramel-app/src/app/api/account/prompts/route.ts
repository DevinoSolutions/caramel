import { withRoute } from '@/lib/api/withRoute'
import prisma from '@/lib/prisma'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// PATCH /api/account/prompts — Settings > "Show tips and prompts", the global
// growth-prompt kill switch (fleet growth-prompts spec §B).
//
// Same shape and same reasoning as account/savings-sync: ONE authority (the
// users row) that every device reads back, and the PERSISTED value in the
// response rather than the requested one, so the switch can never show a
// state the account disagrees with. The signed-out mirror in localStorage is
// written by the client from this response, never the other way round.
const PromptsBodySchema = z.object({
    enabled: z.boolean(),
})

export const PATCH = withRoute(
    {
        method: 'PATCH',
        routeName: 'account/prompts',
        rateLimit: 'mutation',
        origin: true,
        auth: 'session',
        body: PromptsBodySchema,
    },
    async ({ body, session }) => {
        if (!session?.user) {
            // withRoute's auth gate already 401s a missing session; this guard
            // covers the malformed-session edge (and narrows the type).
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const updated = await prisma.user.update({
            where: { id: session.user.id },
            data: { growthPromptsEnabled: body.enabled },
            select: { growthPromptsEnabled: true },
        })

        return NextResponse.json({
            growthPromptsEnabled: updated.growthPromptsEnabled,
        })
    },
)
