'use client'
// src/lib/auth/authRedirectGuard.ts
//
// One circuit breaker for every client-side "you are signed out, go to
// /login" redirect (T-10055).
//
// Oct 24-26 2026: the iOS and macOS app shells (CaramelApp 1.5.0 / 1.6.0) ran
// signed-out shoppers through /profile#favorites -> /login -> /profile#favorites
// every ~150 ms, 19,618 pageviews from 12 ids in PostHog. /profile pushed
// /login onto history and the shell steps back from /login to run its native
// sign-in, so Back landed on /profile, which bounced again. 95a0e925 (T-8896)
// made the redirect a replace, which ends that loop, and newer shells carry
// their own BounceGuard. The installed 1.5.0 / 1.6.0 shells still step back
// with no guard, so any future page or shell change that recreates a bounce
// would loop again with nothing to stop it and nothing in Sentry.
//
// So every auth redirect asks this guard first. More than AUTH_REDIRECT_LIMIT
// redirects inside AUTH_REDIRECT_WINDOW_MS is a loop, not a shopper: the
// redirect is refused, the caller shows a sign-in prompt in place, and one
// `auth_redirect_loop` Sentry event per browser session records both paths,
// the auth state, and the app shell from the user agent.
//
// The count lives in sessionStorage because a loop may be full page loads
// (location.replace, a shell's goBack) as well as client-side navigations; it
// falls back to module memory where sessionStorage throws. Never throws.

import { detectAppShell } from '@/lib/surface/detectSurface'
import * as Sentry from '@sentry/nextjs'

/** Redirects allowed inside the window; the next one is refused. */
export const AUTH_REDIRECT_LIMIT = 5
export const AUTH_REDIRECT_WINDOW_MS = 60_000

const COUNT_KEY = 'caramel:auth-redirects'
const REPORTED_KEY = 'caramel:auth-redirect-loop-reported'

export interface AuthRedirectAttempt {
    /** Path being left; only its pathname is reported. */
    from: string
    /** Path the caller wants to send the shopper to; pathname reported. */
    to: string
    /** The client session store holds a user. */
    hasSession: boolean
    /** The client session check is still in flight. */
    sessionPending: boolean
    /** The server answered 401 for a session the client believed in. */
    serverRejectedSession: boolean
}

/**
 * Pure decision: drop timestamps outside the window, refuse when the window
 * is already full, otherwise record `now`.
 */
export function decideAuthRedirect(
    previous: readonly number[],
    now: number,
): { allowed: boolean; recent: number[] } {
    const recent = previous.filter(
        t =>
            Number.isFinite(t) && t <= now && now - t < AUTH_REDIRECT_WINDOW_MS,
    )
    if (recent.length >= AUTH_REDIRECT_LIMIT) return { allowed: false, recent }
    return { allowed: true, recent: [...recent, now] }
}

let memoryTimestamps: number[] = []
let memoryReported = false

function readTimestamps(): number[] {
    try {
        if (typeof sessionStorage === 'undefined') return memoryTimestamps
        const raw = sessionStorage.getItem(COUNT_KEY)
        if (!raw) return memoryTimestamps
        const parsed: unknown = JSON.parse(raw)
        return Array.isArray(parsed)
            ? parsed.filter((t): t is number => typeof t === 'number')
            : []
    } catch {
        return memoryTimestamps
    }
}

function writeTimestamps(timestamps: number[]): void {
    memoryTimestamps = timestamps
    try {
        if (typeof sessionStorage === 'undefined') return
        sessionStorage.setItem(COUNT_KEY, JSON.stringify(timestamps))
    } catch {
        // sessionStorage unavailable: module memory still covers client-side
        // navigations.
    }
}

/** True the first time in this browser session; marks it reported. */
function claimReport(): boolean {
    if (memoryReported) return false
    memoryReported = true
    try {
        if (typeof sessionStorage === 'undefined') return true
        if (sessionStorage.getItem(REPORTED_KEY) !== null) return false
        sessionStorage.setItem(REPORTED_KEY, '1')
    } catch {
        // Best effort: module memory already holds the flag.
    }
    return true
}

/**
 * The path as reported: pathname only. A fragment or query is whatever the
 * visitor's URL carried (`/profile#<anything>`), so neither reaches Sentry;
 * callers keep the full path for the navigation itself.
 */
function reportedPath(path: string): string {
    const end = path.search(/[?#]/)
    return end >= 0 ? path.slice(0, end) : path
}

/**
 * Forget the redirect count once the server has confirmed a session (the
 * account overview answered 200). Without this, redirects before a sign-in
 * would still count against a signed-out visit soon after it. The
 * once-per-session report flag is kept.
 */
export function clearAuthRedirectCount(): void {
    writeTimestamps([])
}

/**
 * Ask before an auth redirect. True: go ahead (the redirect is counted).
 * False: a loop; do not navigate, show the sign-in prompt in place.
 */
export function guardAuthRedirect(
    attempt: AuthRedirectAttempt,
    now: number = Date.now(),
): boolean {
    try {
        const { allowed, recent } = decideAuthRedirect(readTimestamps(), now)
        writeTimestamps(recent)
        if (allowed) return true

        if (claimReport()) {
            const ua =
                typeof navigator === 'undefined' ? '' : navigator.userAgent
            const shell = detectAppShell(ua)
            Sentry.captureMessage('auth_redirect_loop', {
                level: 'warning',
                tags: {
                    operation: 'auth_redirect_loop',
                    surface: shell ? 'app-shell' : 'web',
                    app_shell_platform: shell?.platform ?? 'none',
                },
                extra: {
                    from: reportedPath(attempt.from),
                    to: reportedPath(attempt.to),
                    hasSession: attempt.hasSession,
                    sessionPending: attempt.sessionPending,
                    serverRejectedSession: attempt.serverRejectedSession,
                    redirectsInWindow: recent.length,
                    windowMs: AUTH_REDIRECT_WINDOW_MS,
                    appShellVersion: shell?.version ?? null,
                },
            })
        }
        return false
    } catch (error) {
        // A broken guard must never strand a signed-out shopper: report it
        // and let the redirect through.
        Sentry.captureException(error, {
            tags: { operation: 'auth_redirect_guard' },
        })
        return true
    }
}

/** Test-only: forget the in-memory count and report flag. */
export function resetAuthRedirectGuardForTests(): void {
    memoryTimestamps = []
    memoryReported = false
}
