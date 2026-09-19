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

export type Surface = 'web' | 'extension' | 'pwa'

export type SurfaceInput = {
    /** Value of `<html data-caramel-extension>` — null when absent. */
    extensionStamp: string | null
    /** A `caramel-ext-hello` or `caramel-ext-present` message was heard. */
    extensionMessageSeen: boolean
    /** `matchMedia('(display-mode: standalone)')` (or window-controls-overlay). */
    displayModeStandalone: boolean
    /** iOS Safari's `navigator.standalone`. */
    navigatorStandalone: boolean
}

/** The attribute the extension stamps on <html> on trusted Caramel origins. */
export const EXTENSION_STAMP_ATTRIBUTE = 'data-caramel-extension'

/** Window message types the extension posts on our own origin. */
export const EXTENSION_MESSAGE_TYPES: ReadonlySet<string> = new Set([
    'caramel-ext-hello',
    'caramel-ext-present',
])

export function detectSurface(input: SurfaceInput): Surface {
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
    return surface !== 'extension'
}
