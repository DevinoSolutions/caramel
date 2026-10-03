// Sign in with Apple's "client secret" is not a static secret: it is an ES256
// JWT that WE sign with the .p8 private key from the Apple developer portal.
// Apple rejects any such JWT valid for more than 15,777,000 s (~6 months), so a
// pre-signed value pasted into the deploy env WILL expire. That is exactly what
// happened on 2026-09-27: the static APPLE_CLIENT_SECRET lapsed and Apple
// sign-in failed on prod + dev. The app now signs its own secret at runtime
// from APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY (see src/lib/env.ts).
//
// Two consumers share this ONE helper so they can never disagree:
//   - src/lib/auth/auth.ts (better-auth's `socialProviders.apple`)
//   - src/app/api/extension/oauth/route.ts (the extension's token exchange)
import 'server-only'

import { env } from '@/lib/env'
import { SignJWT, importPKCS8 } from 'jose'

const APPLE_AUDIENCE = 'https://appleid.apple.com'
const SECONDS_PER_DAY = 86_400
// 180 days = 15,552,000 s, safely under Apple's 15,777,000 s cap.
const SECRET_LIFETIME_SECONDS = 180 * SECONDS_PER_DAY
// Re-sign once fewer than 30 days remain, so a long-lived container (the
// extension route calls this per request) never hands Apple an expired token.
const RESIGN_WHEN_REMAINING_SECONDS = 30 * SECONDS_PER_DAY

interface CachedSecret {
    token: string
    expiresAtSeconds: number
}

let cached: CachedSecret | undefined

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000)
}

interface AppleSigningConfig {
    clientId: string
    teamId: string
    keyId: string
    privateKeyPem: string
}

function readAppleSigningConfig(): AppleSigningConfig {
    const clientId = env.APPLE_CLIENT_ID
    const teamId = env.APPLE_TEAM_ID
    const keyId = env.APPLE_KEY_ID
    const privateKey = env.APPLE_PRIVATE_KEY

    // env.ts already fails the boot when APPLE_CLIENT_ID is set without the
    // other three; this guard is the loud answer for a caller that asks for a
    // secret while Apple is not (fully) configured.
    const missing: string[] = []
    if (!clientId) missing.push('APPLE_CLIENT_ID')
    if (!teamId) missing.push('APPLE_TEAM_ID')
    if (!keyId) missing.push('APPLE_KEY_ID')
    if (!privateKey) missing.push('APPLE_PRIVATE_KEY')
    if (!clientId || !teamId || !keyId || !privateKey) {
        throw new Error(
            `Cannot sign the Apple client secret: ${missing.join(', ')} not set. Sign in with Apple needs all four (APPLE_CLIENT_ID plus the team id, key id and .p8 key it signs with).`,
        )
    }

    // Dokploy's env writer stores values UNQUOTED on ONE line, so the .p8 PEM
    // arrives with literal two-character "\n" sequences; a real multi-line
    // value (local .env, compose) has none and passes through unchanged.
    const privateKeyPem = privateKey.replace(/\\n/g, '\n').trim()
    return { clientId, teamId, keyId, privateKeyPem }
}

async function signAppleClientSecret(): Promise<CachedSecret> {
    const { clientId, teamId, keyId, privateKeyPem } = readAppleSigningConfig()

    let privateKey: Awaited<ReturnType<typeof importPKCS8>>
    try {
        privateKey = await importPKCS8(privateKeyPem, 'ES256')
    } catch (cause) {
        // Never echo the key (or any part of it) into the message or logs: only
        // jose's own reason is appended (it describes the failure, not the key).
        const reason = cause instanceof Error ? cause.message : String(cause)
        throw new Error(
            `APPLE_PRIVATE_KEY is not a valid PKCS#8 P-256 PEM (${reason}). Expected the full contents of the AuthKey_<KEY_ID>.p8 file from the Apple developer portal (-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----), with newlines either real or written as literal \\n.`,
        )
    }

    const issuedAtSeconds = nowSeconds()
    const expiresAtSeconds = issuedAtSeconds + SECRET_LIFETIME_SECONDS
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: keyId })
        .setIssuer(teamId)
        .setSubject(clientId)
        .setAudience(APPLE_AUDIENCE)
        .setIssuedAt(issuedAtSeconds)
        .setExpirationTime(expiresAtSeconds)
        .sign(privateKey)

    return { token, expiresAtSeconds }
}

/**
 * The current Apple client-secret JWT, signed in-process and cached until
 * fewer than 30 days of validity remain. Throws (never returns a stale or
 * empty secret) when Apple's signing config is missing or the key is invalid.
 */
export async function getAppleClientSecret(): Promise<string> {
    if (
        cached &&
        cached.expiresAtSeconds - nowSeconds() > RESIGN_WHEN_REMAINING_SECONDS
    ) {
        return cached.token
    }
    cached = await signAppleClientSecret()
    return cached.token
}
