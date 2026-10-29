// src/lib/surface/detectSurface.ts
//
// WHERE the visitor is looking at Caramel from — fleet growth-prompts spec §A.
// Every app in the fleet exposes a surface detector; Caramel's installed
// product is a browser extension rather than a native shell, so its surfaces
// are:
//
//   web        a browser tab, extension not detected
//   extension  a browser tab in which the Caramel extension is running
//   pwa        the site launched from the home screen (manifest.json is
//              installable). The PWA is still just the website — it does NOT
//              have the extension — so it is a distinct surface for analytics
//              but it does not hide extension CTAs (see canAdvertiseInstall).
//   app-shell  a page rendered inside the Caramel iOS/macOS/Android/Fire store
//              app's WebView. The shell appends "CaramelApp/<version> (<platform>)"
//              to the user agent. Marketing chrome (header, footer, install CTAs,
//              growth prompts) is hidden; page content stays.
//
// The extension announces itself two ways, and this reads both because they
// ship on different schedules:
//   1. `data-caramel-extension="<version>"` on <html>, stamped by every build
//      that carries `caramelStampPresence` (coupon-runner.js). Lands at
//      document_idle, usually before React hydrates.
//   2. The `caramel-ext-hello` / `caramel-ext-present` window messages the
//      content script posts on our origin (older builds only send the hello,
//      and only while they have no session).
//
// PURE — the provider gathers the inputs, this decides. Every branch is
// unit-tested (tests/unit/detectSurface.test.ts).

export type Surface = 'web' | 'extension' | 'pwa' | 'app-shell'

/** Platforms the native shell identifies itself as in the UA suffix. */
export type AppShellPlatform = 'ios' | 'macos' | 'android' | 'fire'

export type SurfaceInput = {
    /** Value of `<html data-caramel-extension>` — null when absent. */
    extensionStamp: string | null
    /** A `caramel-ext-hello` or `caramel-ext-present` message was heard. */
    extensionMessageSeen: boolean
    /** `matchMedia('(display-mode: standalone)')` (or window-controls-overlay). */
    displayModeStandalone: boolean
    /** iOS Safari's `navigator.standalone`. */
    navigatorStandalone: boolean
    /** The user agent string, used to detect the native app shell. */
    userAgent: string
}

/** The attribute the extension stamps on <html> on trusted Caramel origins. */
export const EXTENSION_STAMP_ATTRIBUTE = 'data-caramel-extension'

/** Window message types the extension posts on our own origin. */
export const EXTENSION_MESSAGE_TYPES: ReadonlySet<string> = new Set([
    'caramel-ext-hello',
    'caramel-ext-present',
])

/**
 * Matches the " CaramelApp/<semver> (<platform>)" suffix the native shells
 * append to their WebView's user agent. Returns {version, platform} or null.
 *
 * Requirements (T-7853 acceptance check 4):
 * - Rejects "CaramelApp/1.6 (ios)"      (missing patch)
 * - Rejects "XCaramelApp/1.6.0 (ios)"   (no word boundary before)
 * - Rejects "CaramelApp/1.6.0 (windows)" (unknown platform)
 * - Accepts all four platforms: ios, macos, android, fire
 */
const APP_SHELL_RE =
    /(?:^|\s)CaramelApp\/(\d+\.\d+\.\d+) \((ios|macos|android|fire)\)(?:\s|$)/

/**
 * The separate " CaramelBuild/<build>" token the shells append AFTER the
 * CaramelApp token (T-10055): iOS CFBundleVersion / Android versionCode, so
 * analytics can tell which build looped. It is deliberately a second token, not
 * part of the CaramelApp one, so APP_SHELL_RE (and the inline copy in
 * app/layout.tsx) keep matching every shell build, old or new. Read only once
 * the CaramelApp token has matched.
 */
const APP_BUILD_RE = /(?:^|\s)CaramelBuild\/(\d+)(?:\s|$)/

export type AppShellInfo = {
    version: string
    platform: AppShellPlatform
    /** The native build number; absent on shells that predate the token. */
    build?: string
}

export function detectAppShell(ua: string): AppShellInfo | null {
    const m = APP_SHELL_RE.exec(ua)
    if (!m) return null
    const info: AppShellInfo = {
        version: m[1],
        platform: m[2] as AppShellPlatform,
    }
    const build = APP_BUILD_RE.exec(ua)
    if (build) info.build = build[1]
    return info
}

/**
 * The PostHog super properties an app-shell visit carries. `app_version` is
 * already the WEB release (identity.ts), so the shell's own version is
 * `app_shell_version`; `app_build` is omitted when the shell sent no build.
 */
export function appShellSuperProperties(
    shell: AppShellInfo,
): Record<string, string> {
    return {
        surface: 'app-shell',
        app_platform: shell.platform,
        app_shell_version: shell.version,
        ...(shell.build ? { app_build: shell.build } : {}),
    }
}

export function detectSurface(input: SurfaceInput): Surface {
    // app-shell beats extension and pwa (T-7853).
    if (detectAppShell(input.userAgent)) {
        return 'app-shell'
    }
    if (input.extensionStamp !== null || input.extensionMessageSeen) {
        return 'extension'
    }
    if (input.displayModeStandalone || input.navigatorStandalone) {
        return 'pwa'
    }
    return 'web'
}

/**
 * Whether ANY "get the extension" UI may render. The rule from the spec —
 * nothing that advertises the app renders where the app already is — plus the
 * one Caramel-specific fact: `'unknown'` is "not resolved YET" (first client
 * render, before the provider's effect), and the marketing page must not blank
 * its hero for every visitor while it waits. A CTA that flashes for a fraction
 * of a second for extension users is the cheaper failure; the pre-hydration
 * CSS rule in globals.css hides even that when the stamp is present.
 */
export function canAdvertiseInstall(surface: Surface | 'unknown'): boolean {
    return surface !== 'extension' && surface !== 'app-shell'
}
