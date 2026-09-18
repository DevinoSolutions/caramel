import {
    canAdvertiseInstall,
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
})

describe('canAdvertiseInstall', () => {
    it('never advertises the extension to someone running it', () => {
        expect(canAdvertiseInstall('extension')).toBe(false)
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
