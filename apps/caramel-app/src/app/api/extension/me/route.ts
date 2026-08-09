import { preflight, withRoute } from '@/lib/api/withRoute'
import prisma from '@/lib/prisma'
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

        // The savings-sync consent flag, read from the users table rather than
        // off `session.user`. better-auth only projects the fields it knows
        // about onto the session, so a custom column arrives as `undefined`
        // there — falsy, and therefore silently indistinguishable from a real
        // "off". The popup switch renders from this value, so a silent false
        // would show every consenting shopper an off switch and quietly stop
        // their sync. A dedicated read is the cheap price of not guessing.
        const preference = await prisma.user.findUnique({
            where: { id: session.user.id },
            select: { savingsSyncEnabled: true },
        })

        return NextResponse.json({
            username: username || name || email || null,
            image: image || null,
            savingsSyncEnabled: preference?.savingsSyncEnabled ?? false,
        })
    },
)
