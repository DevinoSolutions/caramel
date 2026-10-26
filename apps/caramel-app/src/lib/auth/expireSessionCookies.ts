// src/lib/auth/expireSessionCookies.ts
//
// Expires the better-auth session cookies a browser holds, from a route that
// ends the account outside better-auth's own endpoints (account/delete, T-8946).
//
// WHY: auth.ts enables the session COOKIE CACHE (session_data, maxAge 5 min).
// getSession answers from that signed cookie without reading the sessions
// table, so deleting the user row (and, by cascade, its sessions) does NOT sign
// the browser out: until the cache expires, /profile renders the deleted
// account and the client re-identifies the deleted id to PostHog, which
// re-creates the person the route just deleted (found in the T-7505 proof walk,
// 2026-10-26). better-auth's own deleteSessionCookie needs an endpoint context,
// so this does the same thing on a NextResponse with better-auth's cookie
// names and attributes (getCookies), never hand-written ones.
//
// LIMIT: this clears the cookies of the browser that made the request only.
// Another browser of the same account keeps a valid-looking cache for up to
// session.cookieCache.maxAge; its next DB-backed check (cache expiry) fails.
import { auth } from '@/lib/auth/auth'
import { getCookies } from 'better-auth/cookies'
import type { NextRequest, NextResponse } from 'next/server'
import 'server-only'

type BetterAuthCookie = ReturnType<typeof getCookies>['sessionToken']

function expire(
    res: NextResponse,
    name: string,
    attributes: BetterAuthCookie['attributes'],
): void {
    res.cookies.set(name, '', {
        path: attributes.path,
        domain: attributes.domain,
        secure: attributes.secure,
        httpOnly: attributes.httpOnly,
        sameSite: attributes.sameSite.toLowerCase() as
            'lax' | 'strict' | 'none',
        maxAge: 0,
    })
}

export function expireSessionCookies(
    req: NextRequest,
    res: NextResponse,
): void {
    const cookies = getCookies(auth.options)
    for (const cookie of [
        cookies.sessionToken,
        cookies.sessionData,
        cookies.dontRememberToken,
    ]) {
        expire(res, cookie.name, cookie.attributes)
    }
    // A session_data cache too large for one cookie is split into
    // `<name>.0`, `<name>.1`, ...; expire every chunk the browser sent.
    const chunkPrefix = `${cookies.sessionData.name}.`
    for (const { name } of req.cookies.getAll()) {
        if (name.startsWith(chunkPrefix)) {
            expire(res, name, cookies.sessionData.attributes)
        }
    }
}
