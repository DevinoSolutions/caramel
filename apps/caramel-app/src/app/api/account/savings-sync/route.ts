import { withRoute } from '@/lib/api/withRoute'
import prisma from '@/lib/prisma'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// PATCH /api/account/savings-sync — the opt-in consent switch itself.
//
// ONE authority, two surfaces: the extension popup's "Sync my savings" row and
// the website's /profile switch both write here, and both read the result back
// rather than trusting their own optimistic value. A device-local flag could
// not do this — the website cannot read extension storage, so a second copy of
// the truth would let the two surfaces disagree about whether a shopper had
// consented to uploading their shopping record.
//
// Turning this OFF stops new events being accepted-and-pushed; it deliberately
// does NOT delete history. "Stop sending more" and "erase what you have" are
// different requests, and conflating them would make the switch irreversible in
// practice while the UI promises the opposite. Deletion is its own explicit act
// on /profile's danger zone.
const SavingsSyncBodySchema = z.object({
    enabled: z.boolean(),
})

export const PATCH = withRoute(
    {
        method: 'PATCH',
        routeName: 'account/savings-sync',
        rateLimit: 'mutation',
        origin: true,
        auth: 'session',
        body: SavingsSyncBodySchema,
    },
    async ({ body, session }) => {
        if (!session?.user) {
            // withRoute's auth gate already 401s a missing session; this guard
            // covers the malformed-session edge (and narrows the type).
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const updated = await prisma.user.update({
            where: { id: session.user.id },
            data: { savingsSyncEnabled: body.enabled },
            select: { savingsSyncEnabled: true },
        })

        // The PERSISTED value, not the requested one. A client that renders its
        // own optimistic guess can show a switch that is on while the account
        // says off — the exact drift a single authority exists to prevent.
        return NextResponse.json({
            savingsSyncEnabled: updated.savingsSyncEnabled,
        })
    },
)
