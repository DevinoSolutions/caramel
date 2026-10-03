// Sign in with Apple's "client secret" is not a static secret: it is an ES256
// JWT that WE sign with the .p8 private key from the Apple developer portal.
// Apple rejects any such JWT valid for more than 15,777,000 s (~6 months), so a
// pre-signed value pasted into the deploy env WILL expire. That is exactly what
// happened on 2026-09-27: the static APPLE_CLIENT_SECRET lapsed and Apple
// sign-in failed on prod + dev. The app now signs its own secret at runtime
// from APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY (see src/lib/env.ts).
//
// Two consumers share this ONE helper so they can never disagree:
//   - src/lib/auth/auth.ts (better-auth's `socialProviders.apple`, through
//     `createAppleSocialProviderConfig`)
//   - src/app/api/extension/oauth/route.ts (the extension's token exchange)
//
// SYNCHRONOUS ON PURPOSE (node:crypto, not an async JOSE library). better-auth
// 1.6.23 resolves the `socialProviders.apple` config ONCE (create-context.mjs)
// and its Apple provider keeps that same object, reading `options.clientSecret`
// at every token exchange / refresh. A `get clientSecret()` on that object only
// stays fresh if the secret can be produced synchronously at read time.
import 'server-only'

import { createPrivateKey, sign, type KeyObject } from 'node:crypto'

import { env } from '@/lib/env'

const APPLE_AUDIENCE = 'https://appleid.apple.com'
const SECONDS_PER_DAY = 86_400
// 180 days = 15,552,000 s, safely under Apple's 15,777,000 s cap.
const SECRET_LIFETIME_SECONDS = 180 * SECONDS_PER_DAY
// Re-sign once fewer than 30 days remain, so a long-lived container (both
// consumers read the secret per request) never hands Apple an expired token.
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

function base64UrlJson(value: Record<string, string | number>): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function parseApplePrivateKey(privateKeyPem: string): KeyObject {
    // Never echo the key (or any part of it) into the message or logs: only
    // the reason is appended (OpenSSL describes the failure, not the input).
    let privateKey: KeyObject
    try {
        privateKey = createPrivateKey({ key: privateKeyPem, format: 'pem' })
    } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        throw new Error(
            `APPLE_PRIVATE_KEY is not a valid PKCS#8 P-256 PEM (${reason}). Expected the full contents of the AuthKey_<KEY_ID>.p8 file from the Apple developer portal (-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----), with newlines either real or written as literal \\n.`,
        )
    }
    const curve = privateKey.asymmetricKeyDetails?.namedCurve
    if (privateKey.asymmetricKeyType !== 'ec' || curve !== 'prime256v1') {
        throw new Error(
            `APPLE_PRIVATE_KEY parsed but is not a P-256 EC key (found ${privateKey.asymmetricKeyType ?? 'unknown'}${curve ? `/${curve}` : ''}); Sign in with Apple client secrets are ES256, which needs the .p8 key from the Apple developer portal.`,
        )
    }
    return privateKey
}

function signAppleClientSecret(): CachedSecret {
    const { clientId, teamId, keyId, privateKeyPem } = readAppleSigningConfig()
    const privateKey = parseApplePrivateKey(privateKeyPem)

    const issuedAtSeconds = nowSeconds()
    const expiresAtSeconds = issuedAtSeconds + SECRET_LIFETIME_SECONDS
    const header = base64UrlJson({ alg: 'ES256', kid: keyId })
    const payload = base64UrlJson({
        iss: teamId,
        iat: issuedAtSeconds,
        exp: expiresAtSeconds,
        aud: APPLE_AUDIENCE,
        sub: clientId,
    })
    const signingInput = `${header}.${payload}`
    // JWS ES256 wants the fixed-width raw r||s signature (RFC 7518 3.4), not
    // the DER encoding node emits by default.
    const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
    })
    return {
        token: `${signingInput}.${signature.toString('base64url')}`,
        expiresAtSeconds,
    }
}

/**
 * The current Apple client-secret JWT, signed in-process and cached until
 * fewer than 30 days of validity remain. Throws (never returns a stale or
 * empty secret) when Apple's signing config is missing or the key is invalid;
 * a failed sign leaves the cache untouched, so the next call retries.
 */
export function getAppleClientSecret(): string {
    if (
        cached &&
        cached.expiresAtSeconds - nowSeconds() > RESIGN_WHEN_REMAINING_SECONDS
    ) {
        return cached.token
    }
    cached = signAppleClientSecret()
    return cached.token
}

export interface AppleSocialProviderConfig {
    clientId: string
    /** Read at every token exchange/refresh by better-auth; always fresh. */
    readonly clientSecret: string
    redirectURI: string
}

/**
 * The better-auth `socialProviders.apple` config. better-auth 1.6.23 resolves
 * the config ONCE (create-context.mjs:97-102) and passes that very object,
 * unspread, to the Apple provider, which reads `options.clientSecret` at each
 * call (apple.mjs `createAuthorizationURL`, validate-authorization-code.mjs,
 * refresh-access-token.mjs). `clientSecret` is therefore a GETTER: a process
 * that outlives the secret it started with re-signs on the next read instead of
 * sending Apple an expired JWT. Do not spread or clone the returned object.
 *
 * Apple unset = disabled: the empty secret is falsy, so better-auth refuses to
 * start a sign-in (CLIENT_ID_AND_SECRET_REQUIRED) instead of signing anything.
 */
export function createAppleSocialProviderConfig(options: {
    redirectURI: string
}): AppleSocialProviderConfig {
    return {
        clientId: env.APPLE_CLIENT_ID as string,
        get clientSecret(): string {
            return env.APPLE_CLIENT_ID ? getAppleClientSecret() : ''
        },
        redirectURI: options.redirectURI,
    }
}
