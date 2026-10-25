// POST /api/app/web-session/handoff — T-7852
//
// The native shell (Android/Fire WebView, iOS/macOS WKWebView) already holds
// a raw session bearer from POST /api/extension/oauth. A WebView cannot use
// that bearer for page loads — it needs the signed better-auth session cookie,
// which only the server can mint. This route trades a valid bearer for a
// one-time code; the shell loads /redeem?code=… as a top-level navigation,
// receives the cookie, and all subsequent page loads are authenticated.
//
// CSRF-safe by design: only a bearer is accepted (a cookie-only request from
// a web page returns 401), no CORS headers are sent, and the code is single-use
// with a 60 s TTL.
import { handleRouteError } from '@/lib/api/handleRouteError'
import { readBodyCapped } from '@/lib/api/readBodyCapped'
import { env } from '@/lib/env'
import { BASE_URL } from '@/lib/env.client'
import prisma from '@/lib/prisma'
import { checkRateLimit } from '@/lib/rateLimit'
import { createHash, randomBytes } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

// The body is one short `next` path (max 512 chars): 4 KiB is generous.
const MAX_BODY_BYTES = 4 * 1024

// Must start with one of these prefixes (or be exactly "/").
const ALLOWED_NEXT_PREFIXES = ['/coupons', '/profile', '/welcome']

const HandoffBody = z.object({
    next: z
        .string()
        .max(512)
        .refine(
            s => {
                // Must be a safe same-origin path
                if (s === '/') return true
                // Reject control characters, whitespace, backslash, // prefix.
                // Check char codes instead of a regex to avoid the
                // no-control-regex lint rule (oxlint does not support inline
                // suppressions for it).
                for (let i = 0; i < s.length; i++) {
                    const c = s.charCodeAt(i)
                    if (c <= 0x1f || c === 0x7f) return false
                }
                if (/\s/.test(s) || s.includes('\\')) return false
                if (s.startsWith('//')) return false
                // Reject anything with a scheme
                if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false
                // Reject percent-encoded CR/LF (header injection)
                if (/%0[dDaA]/i.test(s)) return false
                // Must start with one of the allowed prefixes
                if (!ALLOWED_NEXT_PREFIXES.some(p => s.startsWith(p)))
                    return false
                // Must match the overall path shape
                return /^\/(?!\/)[^\s\\]*$/.test(s)
            },
            { message: 'invalid next' },
        ),
})

export async function POST(req: NextRequest) {
    // No CORS — native caller, no Origin.

    // Rate-limit before any work.
    const limited = await checkRateLimit(req, 'mutation')
    if (limited) return limited

    // --- BEARER-ONLY auth (reject cookie-only requests) ---
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
        return NextResponse.json(
            { error: 'unauthorized' },
            {
                status: 401,
                headers: {
                    'Cache-Control': 'no-store',
                    'Referrer-Policy': 'no-referrer',
                },
            },
        )
    }
    const bearerToken = authHeader.slice(7)

    // Resolve the session via better-auth (the bearer plugin verifies it).
    const { auth } = await import('@/lib/auth/auth')
    // Build headers with ONLY the bearer — strip any cookies so a web page
    // sending both cannot mint a handoff through its cookie.
    const bearerOnlyHeaders = new Headers()
    bearerOnlyHeaders.set('authorization', `Bearer ${bearerToken}`)
    const session = await auth.api.getSession({
        headers: bearerOnlyHeaders,
    })
    if (!session?.session?.id) {
        return NextResponse.json(
            { error: 'unauthorized' },
            {
                status: 401,
                headers: {
                    'Cache-Control': 'no-store',
                    'Referrer-Policy': 'no-referrer',
                },
            },
        )
    }

    // --- Parse and validate body ---
    // Capped like every withRoute body (T-6223): this route skips withRoute
    // for its bearer-only check, not for an unbounded read.
    const body = await readBodyCapped(req, MAX_BODY_BYTES)
    if (!body.ok) {
        return NextResponse.json(
            { error: 'payload too large' },
            {
                status: 413,
                headers: {
                    'Cache-Control': 'no-store',
                    'Referrer-Policy': 'no-referrer',
                },
            },
        )
    }
    let raw: unknown
    try {
        raw = body.text ? JSON.parse(body.text) : undefined
    } catch {
        raw = undefined
    }
    const parsed = HandoffBody.safeParse(raw ?? {})
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid next' },
            {
                status: 400,
                headers: {
                    'Cache-Control': 'no-store',
                    'Referrer-Policy': 'no-referrer',
                },
            },
        )
    }
    const { next } = parsed.data

    // --- Mint the one-time code ---
    const codeBytes = randomBytes(32)
    const code = codeBytes.toString('base64url') // 43 characters
    const codeHash = createHash('sha256').update(code).digest('hex')
    const expiresAt = new Date(Date.now() + 60_000) // 60 seconds

    try {
        await prisma.verification.create({
            data: {
                identifier: `app-web-handoff:${codeHash}`,
                value: JSON.stringify({
                    sessionId: session.session.id,
                    next,
                }),
                expiresAt,
            },
        })
    } catch (error) {
        return handleRouteError(error, {
            req,
            route: 'app/web-session/handoff',
            message: 'Failed to create handoff code',
        })
    }

    const baseUrl = env.BETTER_AUTH_URL || BASE_URL
    const redeemUrl = `${baseUrl}/api/app/web-session/redeem?code=${code}`

    return NextResponse.json(
        { url: redeemUrl, expiresInSeconds: 60 },
        {
            status: 200,
            headers: {
                'Cache-Control': 'no-store',
                'Referrer-Policy': 'no-referrer',
            },
        },
    )
}
