// GET /api/app/web-session/redeem?code=<code> — T-7852
//
// The WebView loads this as a top-level navigation. It consumes the one-time
// code atomically (single use), mints the signed better-auth session cookie,
// and redirects the WebView to the stored `next` path.
//
// No CORS, no bearer — it is a document navigation, not a fetch.
//
// Only the native shell may redeem. A code is a sign-in for whoever minted
// it, so an ordinary browser that opens a redeem link (one an attacker minted
// from their own account and sent on) would be silently signed in to the
// attacker's account, and whatever it then saved would land there. The shells
// load this URL themselves as a top-level navigation, with their
// "CaramelApp/<version> (<platform>)" user agent and no cross-site initiator;
// anything else is refused before the code is touched, so a link preview or a
// stray browser tab cannot burn the shell's code either.
import { authSecret } from '@/lib/authSecret'
import { env } from '@/lib/env'
import { BASE_URL } from '@/lib/env.client'
import prisma from '@/lib/prisma'
import { detectAppShell } from '@/lib/surface/detectSurface'
import * as Sentry from '@sentry/nextjs'
import { createHash, createHmac } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'

/** better-auth's cookie name when useSecureCookies is true. In prod
 *  (HTTPS), the prefix is `__Secure-`; in local HTTP dev it's bare. */
function sessionCookieName(): string {
    const baseUrl = env.BETTER_AUTH_URL || BASE_URL
    const isHTTPS = baseUrl.startsWith('https://')
    const isSecure = isHTTPS || process.env.NODE_ENV === 'production'
    const prefix = isSecure ? '__Secure-' : ''
    return `${prefix}better-auth.session_token`
}

/** Sign a cookie value exactly as better-auth does (Hono's setSignedCookie):
 *  `value.hmac-sha256(secret, value)` in base64. */
function signCookieValue(value: string, secret: string): string {
    const signature = createHmac('sha256', secret)
        .update(value)
        .digest('base64')
    return `${value}.${signature}`
}

const FAILED_REDIRECT = '/login?error=handoff_expired'

/** A navigation the shell itself started: its user agent, and no other site
 *  behind it (`Sec-Fetch-Site` is `none` for a WebView's own load). */
function isShellNavigation(req: NextRequest): boolean {
    if (!detectAppShell(req.headers.get('user-agent') ?? '')) return false
    const site = req.headers.get('sec-fetch-site')
    return site === null || site === 'none' || site === 'same-origin'
}

export async function GET(req: NextRequest) {
    if (!isShellNavigation(req)) {
        return redirect303(FAILED_REDIRECT)
    }

    const code = req.nextUrl.searchParams.get('code')
    if (!code || code.length !== 43) {
        return redirect303(FAILED_REDIRECT)
    }

    const codeHash = createHash('sha256').update(code).digest('hex')
    const identifier = `app-web-handoff:${codeHash}`

    // Atomic consume: delete … returning. Single use.
    let stored: { sessionId: string; next: string } | null = null
    try {
        const rows: { value: string; expiresAt: Date }[] =
            await prisma.$queryRaw`
                DELETE FROM "verification_tokens"
                WHERE "identifier" = ${identifier}
                RETURNING "value", "expiresAt"
            `
        const row = rows[0]
        if (!row || new Date(row.expiresAt) < new Date()) {
            return redirect303(FAILED_REDIRECT)
        }
        stored = JSON.parse(row.value)
    } catch (error) {
        Sentry.captureException(error, {
            tags: { route: 'app/web-session/redeem' },
        })
        return redirect303(FAILED_REDIRECT)
    }

    if (!stored?.sessionId || !stored?.next) {
        return redirect303(FAILED_REDIRECT)
    }

    // Verify the session is still alive (not revoked / signed out since handoff).
    const session = await prisma.session.findUnique({
        where: { id: stored.sessionId },
    })
    if (!session || new Date(session.expiresAt) < new Date()) {
        return redirect303(FAILED_REDIRECT)
    }

    // Mint the signed session cookie exactly as better-auth does.
    const cookieName = sessionCookieName()
    const signedValue = signCookieValue(session.token, authSecret())
    const remainingLifeSec = Math.max(
        0,
        Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000),
    )

    const baseUrl = env.BETTER_AUTH_URL || BASE_URL
    const isHTTPS = baseUrl.startsWith('https://')
    const isSecure = isHTTPS || process.env.NODE_ENV === 'production'

    const res = redirect303(stored.next)
    res.cookies.set(cookieName, signedValue, {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'lax',
        path: '/',
        maxAge: remainingLifeSec,
    })
    return res
}

function redirect303(location: string): NextResponse {
    return new NextResponse(null, {
        status: 303,
        headers: {
            Location: location,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
        },
    })
}
