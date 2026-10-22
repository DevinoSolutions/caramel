// Encryption at rest for the provider tokens stored on `accounts`
// (access_token, refresh_token). ONE format for both writers:
//  - better-auth's own sign-in callback, with `account.encryptOAuthTokens: true`
//    in src/lib/auth/auth.ts: it calls the same `symmetricEncrypt` (XChaCha20-
//    Poly1305, lower-case hex) with the auth secret as the key;
//  - the extension/app mint (extensionOAuthSession.ts), which writes the account
//    row with raw Prisma and so does NOT go through better-auth's encryption.
// This module is the mint's half. It uses better-auth's own primitive and the
// same secret expression auth.ts passes as `secret`, so a row written by either
// path decrypts here, and there is no second key (and no new env) to manage.
//
// Rotating BETTER_AUTH_SECRET makes already-stored tokens undecryptable (the
// same is true of better-auth's own encrypted tokens); `decryptOAuthToken`
// then throws loudly rather than handing back ciphertext.
//
// better-auth leaves id tokens in plain text (link-account.ts), and so do we.
import 'server-only'

import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'

import { env } from '@/lib/env'

/** The key better-auth was configured with (auth.ts `secret:`). env.ts
 * guarantees one of the two is set; the throw is for a caller that outran it. */
function tokenEncryptionKey(): string {
    const key = env.BETTER_AUTH_SECRET ?? env.JWT_SECRET
    if (!key) {
        throw new Error(
            'Cannot encrypt or decrypt stored OAuth tokens: neither BETTER_AUTH_SECRET nor JWT_SECRET is set',
        )
    }
    return key
}

/** Same test better-auth's decryptOAuthToken applies (oauth2/utils.mjs, 1.6.23):
 * rows written before encryption was switched on are plain text and must keep
 * working. Apple/Google tokens contain dots, so they are never mistaken for
 * the even-length hex ciphertext. */
function looksEncrypted(stored: string): boolean {
    return (
        stored.startsWith('$ba$') ||
        (stored.length % 2 === 0 && /^[0-9a-f]+$/i.test(stored))
    )
}

/** Ciphertext for storage; null for an absent token (never encrypts ''). */
export async function encryptOAuthToken(
    token: string | null | undefined,
): Promise<string | null> {
    if (!token) return null
    return symmetricEncrypt({ key: tokenEncryptionKey(), data: token })
}

/** The usable token for a stored value, whether it was written encrypted or,
 * before encryption was enabled, in plain text. Throws if the value looks
 * encrypted but does not decrypt (wrong key, corrupted row). */
export async function decryptOAuthToken(stored: string): Promise<string> {
    if (!looksEncrypted(stored)) return stored
    return symmetricDecrypt({ key: tokenEncryptionKey(), data: stored })
}
