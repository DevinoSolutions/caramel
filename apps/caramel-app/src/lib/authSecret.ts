// The server's auth secret, in its own module (not env.ts) so the many tests
// that vi.mock('@/lib/env') with only `{ env }` still reach it through the
// mocked env (T-9424).
import { env, type ServerEnv } from '@/lib/env'

/**
 * The server's auth secret: BETTER_AUTH_SECRET, else JWT_SECRET. The schema
 * refuses to boot without one of them, so this is never empty; the throw is
 * for a caller handed a bag that skipped that refine. Every signer and HMAC
 * reads its key here: re-deriving it with a `?? ''` fallback would sign
 * under an empty key without a sound (T-9424).
 */
export function authSecret(
    source: Pick<ServerEnv, 'BETTER_AUTH_SECRET' | 'JWT_SECRET'> = env,
): string {
    const secret = source.BETTER_AUTH_SECRET ?? source.JWT_SECRET
    if (!secret) {
        throw new Error(
            'No auth secret: neither BETTER_AUTH_SECRET nor JWT_SECRET is set',
        )
    }
    return secret
}
