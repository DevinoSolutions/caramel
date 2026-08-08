import { preflight, withRoute } from '@/lib/api/withRoute'
import { NextResponse } from 'next/server'

// Validated-identity probe for the extension popup: it calls this with the
// stored bearer token to learn whether the session is still alive (a 401
// clears the extension's stored credentials) and to refresh the displayed
// profile. better-auth's bearer plugin verifies the raw dot-less session
// token from the Authorization header (see the module header in
// src/lib/auth/extensionOAuthSession.ts), so the standard `auth: 'session'`
// gate covers extension-minted tokens too. Username fallback chain matches
// extension/login + createExtensionSessionRow (username || name || email).
export const OPTIONS = preflight({
    cors: 'extension',
    methods: 'GET, OPTIONS',
})

export const GET = withRoute(
    {
        method: 'GET',
        routeName: 'extension/me',
        rateLimit: 'read',
        cors: 'extension',
        auth: 'session',
    },
    async ({ session }) => {
        if (!session?.user) {
            // withRoute's auth gate already 401s a missing session; this
            // guard covers the malformed-session edge (and narrows the type).
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const { username, name, email, image } = session.user
        return NextResponse.json({
            username: username || name || email || null,
            image: image || null,
        })
    },
)
