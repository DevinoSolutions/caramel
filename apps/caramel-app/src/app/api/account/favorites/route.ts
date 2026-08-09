import { listFavoriteStores } from '@/lib/account/favoriteStores'
import { withRoute } from '@/lib/api/withRoute'
import { NextResponse } from 'next/server'

// GET /api/account/favorites — the stores the signed-in user follows.
//
// `auth: 'session'` GATES this one (not 'optional'): a favorites list is
// per-person state with nothing meaningful to serve an anonymous caller, so a
// missing/expired credential is a 401 and the handler never runs. Both callers
// are already signed-in surfaces — the account page's "Stores you follow"
// section and the extension popup's star, which sends the same bearer it uses
// for every other API call.
//
// No CORS / no OPTIONS export, matching coupons/[id]/report: the MV3 extension
// fetches with host_permissions, so its request never preflights and CORS
// headers here would be dead ceremony. `origin: true` still rejects a random
// website's cross-origin fetch (it accepts extension protocols and same-origin
// — see rateLimit.ts's isOriginAllowed).
export const GET = withRoute(
    {
        method: 'GET',
        routeName: 'account/favorites',
        rateLimit: 'read',
        origin: true,
        auth: 'session',
    },
    async ({ session }) => {
        if (!session?.user) {
            // withRoute's auth gate already 401s a missing session; this guard
            // covers the malformed-session edge (and narrows the type), the
            // same way extension/me does.
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const favorites = await listFavoriteStores(session.user.id)
        return NextResponse.json({ favorites })
    },
)
