// src/lib/mcp/authorizeContinuation.ts
//
// Resuming an OAuth 2.1 authorize request that bounced through /login.
//
// The oauthProvider plugin is configured with `loginPage: '/login'`
// (src/lib/auth/auth.ts). When an AI client (Claude, ChatGPT) starts at
// /api/auth/oauth2/authorize and the visitor has no session, the plugin sends
// the BROWSER to `/login?response_type=code&client_id=…&redirect_uri=…&scope=…
// &state=…&code_challenge=…&prompt=consent&exp=…&ba_iat=…&ba_param=…&sig=…`:
// the whole authorize request, HMAC-signed. There is no server-side store, the
// URL is the state, so after sign-in the browser must go back to the authorize
// endpoint with exactly that query.
//
// Pure and dependency-free: the login page passes the result to a client
// component.

/** Better Auth's authorize endpoint (its basePath is /api/auth). */
export const AUTHORIZE_PATH = '/api/auth/oauth2/authorize'

type SearchParamsRecord = Record<string, string | string[] | undefined>

function toSearchParams(record: SearchParamsRecord): URLSearchParams {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(record)) {
        if (value === undefined) continue
        for (const v of Array.isArray(value) ? value : [value]) {
            params.append(key, v)
        }
    }
    return params
}

/**
 * The post-sign-in destination that RESUMES the authorize request this login
 * visit was reached with, or null when the visit is not part of an OAuth flow.
 *
 * Only `prompt` is removed: re-sending `prompt=login`/`prompt=consent` would
 * bounce the fresh session straight back to /login, which loops. Nothing else
 * is reordered or re-encoded, because the provider's HMAC covers the fields
 * named in `ba_param`. Page-only params (`error`, `next`, `verified`,
 * `provider`) are not signed authorize fields and are dropped.
 *
 * The destination is an API route, so callers must navigate with a full
 * browser load (window.location / a social sign-in callbackURL), never
 * router.push.
 */
export function oauthAuthorizeContinuation(
    record: SearchParamsRecord,
): string | null {
    const params = toSearchParams(record)
    if (!params.get('client_id') || !params.get('redirect_uri')) return null
    if (!params.get('sig')) return null
    for (const pageOnly of ['prompt', 'error', 'next', 'verified', 'provider'])
        params.delete(pageOnly)
    return `${AUTHORIZE_PATH}?${params.toString()}`
}
