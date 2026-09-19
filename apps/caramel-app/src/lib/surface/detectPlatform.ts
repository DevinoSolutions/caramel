// src/lib/surface/detectPlatform.ts
//
// Which store listing this visitor most likely wants. Copied from uNotes'
// `lib/device/detectPlatform.ts` (fleet growth-prompts spec, 2026-09-18) and
// extended with the BROWSER, because Caramel's installed product is a browser
// extension: the OS decides whether an extension can exist at all (Android
// Chrome has no extensions; iOS only Safari's), the browser decides which
// store.
//
// Pure functions over a user-agent string rather than a hook that pokes at
// `window`, so every rule is unit-testable — inline sniffing in a component can
// only be checked by opening the page on the device.

export type DevicePlatform = 'ios' | 'android' | 'macos' | 'windows' | 'unknown'

export type BrowserFamily = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other'

/**
 * Order matters. iPadOS 13+ reports a desktop Safari user-agent that is
 * indistinguishable from macOS, which is why the caller passes
 * `maxTouchPoints` — a Mac has 0, an iPad has 5. Without that check every iPad
 * visitor is sent to the Mac listing.
 */
export function detectPlatform(
    userAgent: string,
    maxTouchPoints = 0,
): DevicePlatform {
    const ua = userAgent.toLowerCase()

    if (/iphone|ipod/.test(ua)) return 'ios'
    if (/ipad/.test(ua)) return 'ios'

    if (/android/.test(ua)) return 'android'

    if (/mac os x|macintosh/.test(ua)) {
        return maxTouchPoints > 1 ? 'ios' : 'macos'
    }

    if (/windows/.test(ua)) return 'windows'

    return 'unknown'
}

/**
 * Order matters here too: Edge and every Chromium browser say "Chrome", and
 * Chrome (like everything WebKit-derived) says "Safari", so the more specific
 * token is tested first. Anything Chromium we have no listing for (Brave,
 * Opera, Vivaldi, Arc) reports as `chrome` on purpose — they all install from
 * the Chrome Web Store.
 */
export function detectBrowser(userAgent: string): BrowserFamily {
    const ua = userAgent.toLowerCase()

    if (/edg\//.test(ua)) return 'edge'
    if (/firefox|fxios/.test(ua)) return 'firefox'
    if (/crios|chrome|chromium/.test(ua)) return 'chrome'
    if (/safari/.test(ua)) return 'safari'

    return 'other'
}
