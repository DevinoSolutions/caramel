// POST /api/dev-proof/session — T-9413. DEV-ONLY: never enabled in production.
//
// Mints a session bearer for a throwaway `devproof+<slug>@devino.ca` user so a
// social-only-sign-in app (the Android/iOS shells sign in with Google or Apple
// and nothing else) can be walked signed-in, account deletion included, on an
// emulator without a real external account. The bearer is the same raw session
// token POST /api/extension/oauth hands the native apps (see
// extensionOAuthSession.ts), so the app uses it exactly as after a real sign-in.
//
// Request:  POST, `Authorization: Bearer <DEV_PROOF_SESSION_SECRET>`,
//           JSON `{ "email": "devproof+<slug>@devino.ca" }`
// Response: 200 `{ "token": "<session bearer>", "expiresAt": "<ISO-8601>" }`
//           404 route disabled / production host (no body, same as an unknown route)
//           401 wrong or missing bearer · 422 email outside DEV_PROOF_EMAIL_PATTERN
//           429 over the hourly budget (or withRoute's burst limit)
//
// The policy (the two gates, the email pattern, the timing-safe compare, the
// budget, the audit record) lives in src/lib/devProof.ts; read its header first.
// No CORS and no OPTIONS: the callers are curl and the native shell, never a page.
import { withRoute } from '@/lib/api/withRoute'
import { mintExtensionSession } from '@/lib/auth/extensionOAuthSession'
import {
    DEV_PROOF_EMAIL_PATTERN,
    auditDevProofCall,
    bearerMatches,
    consumeHourlyBudget,
    hashRequesterIp,
    requestTouchesProductionHost,
    type DevProofOutcome,
} from '@/lib/devProof'
import { env } from '@/lib/env'
import { BASE_URL } from '@/lib/env.client'
import prisma from '@/lib/prisma'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

// The pattern is enforced in the handler, AFTER the bearer, so an unauthenticated
// caller cannot probe it; withRoute's schema only rejects a body with no string
// email. 254 is the longest valid address: anything longer is refused unread.
const DevProofBody = z.object({ email: z.string().max(254) })

/** The answer for a disabled route and for a production host: a bare 404, as for a route that does not exist. */
function notFound(): NextResponse {
    return new NextResponse(null, { status: 404, headers: NO_STORE })
}

function refuse(
    status: 401 | 422 | 429,
    error: string,
    outcome: DevProofOutcome,
    email: string | null,
    requesterHash: string,
): NextResponse {
    auditDevProofCall({ outcome, email, requesterHash })
    return NextResponse.json({ error }, { status, headers: NO_STORE })
}

function sessionRoute(secret: string) {
    return withRoute(
        {
            method: 'POST',
            routeName: 'dev-proof/session',
            rateLimit: 'mutation',
            body: DevProofBody,
        },
        async ({ req, body }) => {
            const requesterHash = hashRequesterIp(req.headers)

            if (!(await consumeHourlyBudget(req.headers))) {
                return refuse(
                    429,
                    'Too many requests',
                    'rate_limited',
                    null,
                    requesterHash,
                )
            }
            if (!bearerMatches(req.headers.get('authorization'), secret)) {
                return refuse(
                    401,
                    'Unauthorized',
                    'unauthorized',
                    null,
                    requesterHash,
                )
            }
            // Never log what the caller typed: only an address that matched.
            if (!DEV_PROOF_EMAIL_PATTERN.test(body.email)) {
                return refuse(
                    422,
                    'Invalid request body',
                    'invalid_email',
                    null,
                    requesterHash,
                )
            }

            try {
                // The same find-or-create + session mint a real Google sign-in
                // from the app goes through. The synthetic provider account id is
                // derived from the address, so a second call for the same address
                // finds the same user and mints a fresh session.
                const minted = await mintExtensionSession({
                    provider: 'google',
                    providerUser: {
                        id: `devproof:${body.email}`,
                        email: body.email,
                        name: 'Devproof tester',
                        emailVerified: true,
                    },
                    tokens: {},
                })
                const stored = await prisma.session.findUniqueOrThrow({
                    where: { token: minted.token },
                    select: { expiresAt: true },
                })
                auditDevProofCall({
                    outcome: 'minted',
                    email: body.email,
                    requesterHash,
                })
                return NextResponse.json(
                    {
                        token: minted.token,
                        expiresAt: stored.expiresAt.toISOString(),
                    },
                    { headers: NO_STORE },
                )
            } catch (error) {
                auditDevProofCall({
                    outcome: 'error',
                    email: body.email,
                    requesterHash,
                })
                // withRoute's catch reports it to Sentry (handleRouteError) and
                // answers 500; the audit record above is the "a mint failed" trail.
                throw error
            }
        },
    )
}

export async function POST(req: NextRequest): Promise<NextResponse> {
    // Gate 1: the secret exists only in the DEV deployment's env.
    const secret = env.DEV_PROOF_SESSION_SECRET
    if (!secret) return notFound()

    // Gate 2: refuse a production host even with the secret set.
    if (
        requestTouchesProductionHost({
            host: req.headers.get('host'),
            forwardedHost: req.headers.get('x-forwarded-host'),
            url: req.url,
            publicOrigins: [env.BETTER_AUTH_URL, BASE_URL],
        })
    ) {
        auditDevProofCall({
            outcome: 'refused_production_host',
            email: null,
            requesterHash: hashRequesterIp(req.headers),
        })
        return notFound()
    }

    return sessionRoute(secret)(req)
}
