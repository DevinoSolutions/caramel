import { withRoute } from '@/lib/api/withRoute'
import { revokeConnectedApp } from '@/lib/mcp/connectedApps'
import { NextResponse } from 'next/server'

// DELETE /api/account/connected-apps/[clientId]: disconnect one AI app. Ends
// its consent, deletes its tokens and writes the revocation watermark, so a
// 30-day access token already issued stops working on its next MCP call
// (connectedApps.ts, principal.ts). 404 when that app was not connected.
export const DELETE = withRoute(
    {
        method: 'DELETE',
        routeName: 'account/connected-apps/[clientId]',
        rateLimit: 'mutation',
        origin: true,
        auth: 'session',
    },
    async ({ req, session }) => {
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const clientId = decodeURIComponent(
            new URL(req.url).pathname.split('/').pop() ?? '',
        )
        if (!clientId) {
            return NextResponse.json(
                { error: 'clientId is required' },
                { status: 400 },
            )
        }
        const { wasConnected } = await revokeConnectedApp({
            userId: session.user.id,
            clientId,
        })
        if (!wasConnected) {
            return NextResponse.json(
                { error: 'That app is not connected to this account.' },
                { status: 404 },
            )
        }
        return NextResponse.json({ disconnected: true })
    },
)
