import { preflight, withRoute } from '@/lib/api/withRoute'
import { mintExtensionSessionForUser } from '@/lib/auth/extensionOAuthSession'
import prisma from '@/lib/prisma'
import { NextResponse } from 'next/server'

// DELETE is called cross-origin by the extension itself, so it needs the
// extension CORS preflight. POST stays same-origin-only on its own
// `origin: true` check — advertising OPTIONS here does not loosen it.
export const OPTIONS = preflight({
    cors: 'extension',
    methods: 'DELETE, OPTIONS',
})

// Website→extension sign-in relay: a signed-in page on our own origin
// asks for an extension bearer token so the browser extension can adopt
// the user's session without a second login. Cookie-authenticated
// (auth: 'session') and same-origin only (origin: true rejects
// cross-origin browser callers); the extension side additionally only
// accepts the relayed token from its own origin allowlist.
export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'extension/session',
        rateLimit: 'mutation',
        origin: true,
        auth: 'session',
    },
    async ({ session }) => {
        if (!session?.user?.id) {
            // withRoute's auth gate already 401s a missing session; this
            // guard is for the deleted-user / malformed-session edge.
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const minted = await mintExtensionSessionForUser(session.user.id)
        if (!minted) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        return NextResponse.json(minted)
    },
)

// Revokes the presented extension session. Until this existed, "Log out" in
// the extension only cleared chrome.storage — the server-side Session row
// lived on for its full 7 days, so a token captured before logout kept
// working and sessions accumulated with nothing in the product able to kill
// them.
//
// Authorization is POSSESSION of the token, and the delete is keyed by that
// exact token: a caller can only ever revoke the session it already holds,
// which is strictly less power than it had a moment earlier. That is
// deliberately NOT `auth: 'session'` — the session gate also accepts a
// website cookie, which would let a cookie-authenticated caller revoke an
// arbitrary token it does not possess.
//
// Idempotent by design: an already-revoked or unknown token is a 200 with
// revoked:false, never a 404. Logout must not fail for a user whose session
// has already expired, and a 404-vs-200 split would confirm to an
// unauthenticated caller whether a guessed token exists.
export const DELETE = withRoute(
    {
        method: 'DELETE',
        routeName: 'extension/session',
        rateLimit: 'mutation',
        cors: 'extension',
    },
    async ({ req }) => {
        const header = req.headers.get('authorization') ?? ''
        const token = header.startsWith('Bearer ')
            ? header.slice('Bearer '.length).trim()
            : ''
        if (!token) {
            return NextResponse.json(
                { error: 'Missing bearer token' },
                { status: 401 },
            )
        }
        const { count } = await prisma.session.deleteMany({ where: { token } })
        return NextResponse.json({ revoked: count > 0 })
    },
)
