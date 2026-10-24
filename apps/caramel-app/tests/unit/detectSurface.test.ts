import {
    canAdvertiseInstall,
    detectAppShell,
    detectSurface,
    EXTENSION_MESSAGE_TYPES,
    type SurfaceInput,
} from '@/lib/surface/detectSurface'
import { describe, expect, it } from 'vitest'

// Fleet growth-prompts spec §A: nothing that advertises the app may render
// where the app already is. Each branch of the surface decision is pinned.

const web: SurfaceInput = {
    extensionStamp: null,
    extensionMessageSeen: false,
    displayModeStandalone: false,
    navigatorStandalone: false,
    userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
}

describe('detectSurface', () => {
    it('is web when nothing says otherwise', () => {
        expect(detectSurface(web)).toBe('web')
    })

    it('is extension when the <html> stamp is present, whatever its value', () => {
        expect(detectSurface({ ...web, extensionStamp: '1.4.1' })).toBe(
            'extension',
        )
        expect(detectSurface({ ...web, extensionStamp: '' })).toBe('extension')
    })

    it('is extension when the content script spoke, even without a stamp', () => {
        // Builds before the stamp only send the hello, and only while signed
        // out — still proof the extension is on this browser.
        expect(detectSurface({ ...web, extensionMessageSeen: true })).toBe(
            'extension',
        )
    })

    it('is pwa from the display-mode media query or navigator.standalone', () => {
        expect(detectSurface({ ...web, displayModeStandalone: true })).toBe(
            'pwa',
        )
        expect(detectSurface({ ...web, navigatorStandalone: true })).toBe('pwa')
    })

    it('extension wins over pwa', () => {
        expect(
            detectSurface({
                ...web,
                extensionStamp: '1.4.1',
                displayModeStandalone: true,
            }),
        ).toBe('extension')
    })

    it('accepts both message types the extension has ever posted', () => {
        expect(EXTENSION_MESSAGE_TYPES.has('caramel-ext-hello')).toBe(true)
        expect(EXTENSION_MESSAGE_TYPES.has('caramel-ext-present')).toBe(true)
    })

    it('is app-shell when the UA carries the CaramelApp suffix', () => {
        expect(
            detectSurface({
                ...web,
                userAgent:
                    'Mozilla/5.0 (iPhone) Mobile/15E148 CaramelApp/1.6.0 (ios)',
            }),
        ).toBe('app-shell')
    })

    it('app-shell beats extension and pwa', () => {
        expect(
            detectSurface({
                ...web,
                extensionStamp: '1.4.18',
                displayModeStandalone: true,
                userAgent:
                    'Mozilla/5.0 Mobile/15E148 CaramelApp/1.6.0 (android)',
            }),
        ).toBe('app-shell')
    })
})

describe('detectAppShell', () => {
    it('accepts all four platforms', () => {
        for (const p of ['ios', 'macos', 'android', 'fire'] as const) {
            const r = detectAppShell(`Test CaramelApp/1.6.0 (${p}) Safari`)
            expect(r).toEqual({ version: '1.6.0', platform: p })
        }
    })

    // T-7853 acceptance check 4
    it('rejects a missing patch version', () => {
        expect(detectAppShell('Test CaramelApp/1.6 (ios)')).toBeNull()
    })

    it('rejects a prefix without a word boundary', () => {
        expect(detectAppShell('XCaramelApp/1.6.0 (ios)')).toBeNull()
    })

    it('rejects an unknown platform', () => {
        expect(detectAppShell('Test CaramelApp/1.6.0 (windows)')).toBeNull()
    })
})

describe('canAdvertiseInstall', () => {
    it('never advertises the extension to someone running it', () => {
        expect(canAdvertiseInstall('extension')).toBe(false)
    })

    it('never advertises the extension in the app shell', () => {
        expect(canAdvertiseInstall('app-shell')).toBe(false)
    })

    it('advertises on the web and in the PWA, which has no extension', () => {
        expect(canAdvertiseInstall('web')).toBe(true)
        expect(canAdvertiseInstall('pwa')).toBe(true)
    })

    it('renders the CTA while the surface is still unresolved', () => {
        // First client render — blanking the hero for every visitor while an
        // effect runs would cost far more than a momentary CTA for the few
        // who already have the extension.
        expect(canAdvertiseInstall('unknown')).toBe(true)
    })
})
