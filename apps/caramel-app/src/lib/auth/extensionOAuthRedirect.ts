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

/** True only for a redirect URI that belongs to one of OUR extensions. */
export function isAllowedExtensionRedirectUri(uri: string): boolean {
    let parsed: URL
    try {
        parsed = new URL(uri)
    } catch {
        return false
    }
    const id = extensionIdOf(parsed)
    return id !== null && allowedExtensionIds().has(id)
}
