import { preflight, withRoute } from '@/lib/api/withRoute'
import { consumeNonceResult, isValidNonce } from '@/lib/extension-oauth-nonce'
import { NextResponse } from 'next/server'

// ============================================================================
// COMPATIBILITY SHIM for the shipped Safari/iOS build (store version published
// 2026-04-29): remove after a poll-free Safari version ships.
// TODO(safari-shim-removal)
// ============================================================================
//
// Polled by the SHIPPED Safari/iOS popup to collect the session token that
// /api/extension/oauth/redirect minted server-side. Nothing in this repo's own
// extension calls it — see src/lib/extension-oauth-nonce.ts for why the flow
// exists at all.
//
// The contract below is the published client's, not ours to choose: popup.js
// `pollSafariOauthOnce` (apps/caramel-extension/popup.js:150-168 on the shipped
// `main` tree) treats
//     204            -> still pending, poll again in 2s
//     2xx + {token}  -> signed in
//     2xx, no token  -> error "Empty response from poll"
//     any other code -> error, shown as `errorData.error` (else "Poll failed (N)")
// and `pollSafariOauthUntilDone` (popup.js:170-178) repeats every 2000ms until
// the locally-stored 5-minute deadline. Verified against LIVE prod on
// 2026-08-08: `?nonce=<unknown uuid>` -> 204 empty, no `nonce` -> 400
// {"error":"Missing or invalid nonce"}. Both are reproduced exactly.
//
// RATE LIMIT — 'read', NOT 'mutation': the shipped client's cadence is fixed at
// one request per 2s = 30/min, which is EXACTLY the 'mutation' bucket's 30/min
// cap (src/lib/rateLimit.ts), so 'mutation' would 429 the very flow this shim
// exists to keep alive. 'read' (120/min) leaves headroom for a household behind
// one IP. The original route had no limit at all; a bucket that the client
// cannot trip is the closest safe equivalent. The work per call is one in-memory
// Map lookup.
//
// CORS — withRoute's 'extension' env allowlist, which is TIGHTER than the
// original route's "any chrome-/moz-/safari-web-extension:// origin" prefix
// match. Safe for the shipped client: it calls /authorize first, and authorize
// has always used this same allowlist, so an origin that poll would now reject
// could never have reached poll in the first place.
export const OPTIONS = preflight({ cors: 'extension', methods: 'GET, OPTIONS' })

export const GET = withRoute(
    {
        method: 'GET',
        routeName: 'extension/oauth/poll',
        cors: 'extension',
        rateLimit: 'read',
    },
    async ({ req }) => {
        const nonce = req.nextUrl.searchParams.get('nonce')

        if (!isValidNonce(nonce)) {
            return NextResponse.json(
                { error: 'Missing or invalid nonce' },
                { status: 400 },
            )
        }

        const entry = consumeNonceResult(nonce)
        if (!entry) {
            // Unknown, already-consumed, or expired — all indistinguishable to
            // the client by design, and all mean "keep polling until your own
            // deadline". Returning 404 for an unknown nonce would let a caller
            // probe which nonces are live.
            return new NextResponse(null, { status: 204 })
        }

        if (!entry.token) {
            // Sign-in-failed sentinel written by /redirect. The message stays
            // generic on purpose: the real provider/exchange error is logged
            // server-side rather than handed to whoever holds the nonce.
            return NextResponse.json(
                { error: 'OAuth sign-in failed' },
                { status: 400 },
            )
        }

        return NextResponse.json({
            token: entry.token,
            username: entry.username,
            image: entry.image,
        })
    },
)
