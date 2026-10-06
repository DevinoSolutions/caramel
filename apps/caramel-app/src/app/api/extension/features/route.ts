import { preflight, withRoute } from '@/lib/api/withRoute'
import { env } from '@/lib/env'
import { NextResponse } from 'next/server'

// GET /api/extension/features — the extension's public, keyless read of the
// server-side feature switches. The extension background caches the answer for
// hours, so this stays a tiny constant-time read with no DB access.
//
// shopperCodeCapture: does the server accept codes the shopper typed at
// checkout (POST /api/coupons/submit with source 'checkout')? Mirrors
// SHOPPER_CODE_CAPTURE_ENABLED, which defaults to false in code and is set true
// in prod (owner approved the privacy-policy sentence 2026-10-06); the
// extension must not even send a capture while this is false.
//
// withRoute: public read like extension/supported-stores (rate-limited, no
// auth/origin gate); cors 'extension' + the OPTIONS preflight mirror
// extension/me, so a preflighted extension-origin fetch can read it.
// The answer is an env flag read at request time: never let a build or CDN
// freeze it (same reason api/version is dynamic).
export const dynamic = 'force-dynamic'

export const OPTIONS = preflight({
    cors: 'extension',
    methods: 'GET, OPTIONS',
})

export const GET = withRoute(
    {
        method: 'GET',
        routeName: 'extension/features',
        rateLimit: 'read',
        cors: 'extension',
    },
    () =>
        NextResponse.json({
            shopperCodeCapture: env.SHOPPER_CODE_CAPTURE_ENABLED,
        }),
)
