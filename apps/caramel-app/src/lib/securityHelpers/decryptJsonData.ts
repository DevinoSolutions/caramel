import { decryptJsonClient } from './cryptoHelpers'

// Thrown when an encrypted payload fails to decrypt (F-002). Previously the
// catch below silently returned the still-encrypted payload as if it were
// plaintext — callers had no way to distinguish a successful decrypt from a
// failed one. Throwing is the honest signal; the sole caller
// (app/(marketing)/sources/page.tsx, a client component) handles it with an
// error state + toast.
export class DecryptError extends Error {
    constructor(public readonly cause?: unknown) {
        super('Failed to decrypt response payload')
        this.name = 'DecryptError'
    }
}

// What a route may hand back: the final payload nested under `pageData` or
// `response` (still base64-encrypted when encryption is enabled), or the
// already-unwrapped payload itself.
type MaybeEncrypted<T> = {
    pageData?: T | string
    response?: T | string
}

export function decryptJsonData<T = unknown>(
    resData: MaybeEncrypted<T> | T,
): T {
    const wrapped = resData as MaybeEncrypted<T> | undefined

    // Raw process.env read (not the `clientEnv` singleton in
    // src/lib/env.client.ts): tests/unit/decryptJsonData.test.ts exercises
    // this per-call via vi.stubEnv, which mutates process.env live;
    // clientEnv is parsed once at import time and wouldn't observe
    // per-test stubs. NEXT_PUBLIC_API_ENCRYPTION_ENABLED is still declared
    // in that schema (documented in .env.example / covered by the drift
    // check) — only this call site's read stays dynamic.
    //
    // If encryption is not enabled, return raw response
    if (process.env.NEXT_PUBLIC_API_ENCRYPTION_ENABLED !== 'true') {
        return (
            (wrapped?.pageData as T) ||
            (wrapped?.response as T) ||
            (resData as T)
        )
    }

    // If encryption is enabled but no 'response' or 'encryptPageData' key is found, return raw response
    if (!wrapped?.response && !wrapped?.pageData) {
        return resData as T
    }

    try {
        if (wrapped.pageData) {
            return decryptJsonClient(wrapped.pageData as string) as T
        } else {
            return decryptJsonClient(wrapped.response as string) as T
        }
    } catch (err) {
        throw new DecryptError(err)
    }
}
