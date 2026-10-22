// src/lib/auth/extensionOAuthRedirect.ts
//
// THE one answer to "may an OAuth authorization code (or an OAuth error) be
// sent to this extension redirect URI?" — used by /api/extension/oauth/authorize
// (refuses to sign a state for a foreign destination) and by
// /api/extension/oauth/redirect (refuses to forward to one, on both the success
// AND the error path).
//
// Why an ID allowlist and not a shape check: the Apple leg's intermediate hop
// (/redirect) used to forward the code to ANY `*.chromiumapp.org` or
// `chrome-extension://` destination. Every extension on earth owns a
// chromiumapp.org host, so a third-party extension could start a Caramel Apple
// sign-in with its OWN redirect URI, receive the victim's code, and trade it at
// POST /api/extension/oauth for a Caramel session token (security report
// 2026-10, verified live against prod). The destination's shape proves it is
// an extension; only its ID proves it is OURS.
//
// Google's leg was never exposed the same way because Google itself refuses a
// redirect_uri that is not registered in the Cloud console — this module is
// what gives the Apple leg (whose registered redirect is our own /redirect) the
// same property.
import { env } from '@/lib/env'
import { REJECTED_REDIRECT_SURFACE_TAG } from '@/lib/rejectedRedirectEventScrub'
import * as Sentry from '@sentry/nextjs'

/** Store-published Chromium builds. These IDs are public (they are the store
 * listing URLs) and stable for the life of the listing. Edge assigns its own ID
 * but uses the same `https://<id>.chromiumapp.org/` redirect form as Chrome. */
const PUBLISHED_CHROMIUM_EXTENSION_IDS = [
    'gaimofgglbackoimfjopicmbmnlccfoe', // Chrome Web Store
    'leodahchedhnenmiengkfpmmcdendnof', // Microsoft Edge Add-ons
] as const

const CHROMIUM_EXTENSION_ID = /^[a-p]{32}$/

/** A Chromium extension ID is 32 chars of a-p. Anything else in
 * CHROME_EXTENSION_ORIGIN is a misconfiguration and is ignored rather than
 * widened into the allowlist. */
function idFromChromeExtensionOrigin(origin: string | undefined): string[] {
    if (!origin) return []
    const match = /^chrome-extension:\/\/([^/]+)\/?$/.exec(origin.trim())
    return match && CHROMIUM_EXTENSION_ID.test(match[1]) ? [match[1]] : []
}

/** Published IDs plus the deployment's own CHROME_EXTENSION_ORIGIN (how a
 * locally-loaded unpacked build, whose ID is path-derived, gets in). */
function allowedExtensionIds(): ReadonlySet<string> {
    return new Set<string>([
        ...PUBLISHED_CHROMIUM_EXTENSION_IDS,
        ...idFromChromeExtensionOrigin(env.CHROME_EXTENSION_ORIGIN),
    ])
}

/** The extension ID a redirect URI points at, or null when it is not one of
 * the two forms launchWebAuthFlow uses (`https://<id>.chromiumapp.org/…`,
 * `chrome-extension://<id>/…`) or carries credentials/a port. */
function extensionIdOf(uri: URL): string | null {
    if (uri.username || uri.password || uri.port) return null
    if (uri.protocol === 'chrome-extension:') return uri.hostname
    if (uri.protocol !== 'https:') return null
    const suffix = '.chromiumapp.org'
    if (!uri.hostname.endsWith(suffix)) return null
    const id = uri.hostname.slice(0, -suffix.length)
    // Exactly one label: `a.b.chromiumapp.org` is not an extension host.
    return id.includes('.') ? null : id
}

/** The ONE redirect URI of the native iOS app (apps/caramel-apple). It is the
 * `callbackURLScheme` its ASWebAuthenticationSession listens on, which needs no
 * Info.plist registration and no apple-app-site-association: iOS hands the
 * callback to the session that started the flow, not to whichever app claims
 * the scheme. Reverse-DNS, so it cannot collide with a web scheme. Exact
 * string match only (no path/query/port variants): AppConfig.swift holds the
 * same literal. */
export const NATIVE_APP_REDIRECT_URI = 'com.devino.caramel://auth/callback'

/** True only for the native app's one redirect URI. */
export function isNativeAppRedirectUri(uri: string): boolean {
    return uri === NATIVE_APP_REDIRECT_URI
}

/** The redirect_uri Google is told for `redirectUri`.
 *
 * Google only accepts redirect URIs registered on its web client, and a custom
 * scheme cannot be: the native app's flow therefore goes Google -> our own
 * /api/extension/oauth/redirect (already registered, the Safari leg uses it)
 * -> a bounce to the app scheme. The authorize URL and the code exchange must
 * quote the SAME value, so both call this. Every other redirect URI (the
 * extensions', the Safari shim's) is passed through untouched. (Apple always
 * uses the /redirect hop and builds that URI inline.) */
export function googleRedirectUriFor(
    redirectUri: string,
    baseURL: string,
): string {
    return isNativeAppRedirectUri(redirectUri)
        ? `${baseURL}/api/extension/oauth/redirect`
        : redirectUri
}

/** True only for a redirect URI that belongs to one of OUR extensions, or to
 * our native app. */
export function isAllowedExtensionRedirectUri(uri: string): boolean {
    if (isNativeAppRedirectUri(uri)) return true
    let parsed: URL
    try {
        parsed = new URL(uri)
    } catch {
        return false
    }
    const id = extensionIdOf(parsed)
    return id !== null && allowedExtensionIds().has(id)
}

/** Only the host of a rejected redirect URI is ever put in the report: the
 * full URL can carry the authorization code, state or a token (the redirect
 * hop sees the provider's callback), and userinfo/path/query are
 * attacker-chosen noise. (The SDK may separately attach the REQUEST's own URL;
 * rejectedRedirectEventScrub.ts strips its query string in beforeSend.) */
function hostOfRejectedUri(uri: string): string {
    try {
        return new URL(uri).hostname.slice(0, 100) || '<empty-host>'
    } catch {
        return '<unparseable>'
    }
}

type RejectedRedirectRoute =
    | 'extension/oauth/authorize'
    | 'extension/oauth/redirect'

/** At most one Sentry event per route per window. /redirect is unauthenticated
 * and unthrottled by design (a provider callback), so anyone can loop on a bad
 * extension_redirect, and the self-hosted Sentry accepts only ~5 envelopes/s
 * per project (sentry.common.config.ts): an unthrottled report would let a
 * flood push real errors into 429s. Keyed by ROUTE only, never by host: the
 * attacker picks the host. */
const REPORT_WINDOW_MS = 60_000
const nextReportAt = new Map<RejectedRedirectRoute, number>()
const suppressedSinceLast = new Map<RejectedRedirectRoute, number>()

/**
 * Report that an OAuth route refused an extension redirect URI. A refusal is
 * either an attack (someone crafting a flow toward a foreign extension) or our
 * own allowlist going stale (a new store build whose ID is not listed above),
 * and both must be visible rather than a bare 400. Warning level, one message
 * text so Sentry groups it; the route and provider are tags, the rejected host
 * is the only URI-derived value. Throttled per route (see REPORT_WINDOW_MS);
 * the next event after a window carries `suppressedSinceLast`.
 */
export function reportRejectedExtensionRedirect(args: {
    route: RejectedRedirectRoute
    provider: 'google' | 'apple' | 'unknown'
    redirectUri: string
}): void {
    const now = Date.now()
    if (now < (nextReportAt.get(args.route) ?? 0)) {
        suppressedSinceLast.set(
            args.route,
            (suppressedSinceLast.get(args.route) ?? 0) + 1,
        )
        return
    }
    nextReportAt.set(args.route, now + REPORT_WINDOW_MS)
    const suppressed = suppressedSinceLast.get(args.route) ?? 0
    suppressedSinceLast.delete(args.route)

    Sentry.captureMessage('Disallowed extension OAuth redirect URI', {
        level: 'warning',
        tags: {
            route: args.route,
            provider: args.provider,
            surface: REJECTED_REDIRECT_SURFACE_TAG,
        },
        extra: {
            rejectedHost: hostOfRejectedUri(args.redirectUri),
            suppressedSinceLast: suppressed,
        },
    })
}

/** Test-only reset of the per-route throttle. */
export function resetRejectedRedirectReportThrottleForTests(): void {
    nextReportAt.clear()
    suppressedSinceLast.clear()
}
