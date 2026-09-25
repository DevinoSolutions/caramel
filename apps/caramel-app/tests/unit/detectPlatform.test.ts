import {
    canInstallExtension,
    detectBrowser,
    detectPlatform,
} from '@/lib/surface/detectPlatform'
import { describe, expect, it } from 'vitest'

// Copied from uNotes' detectPlatform.test.ts (fleet growth-prompts spec) plus
// the browser cases Caramel needs — its installed product is an extension, so
// the browser picks the store.

const UA = {
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    ipadLegacy:
        'Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
    // iPadOS 13+ "Request Desktop Website" default — byte-for-byte a Mac.
    macSafari:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    android:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    windowsChrome:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    windowsEdge:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
    linuxFirefox:
        'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
    iosFirefox:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
    iosChrome:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
}

describe('detectPlatform', () => {
    it('recognises an iPhone', () => {
        expect(detectPlatform(UA.iphone)).toBe('ios')
    })

    it('recognises an older iPad that still says iPad', () => {
        expect(detectPlatform(UA.ipadLegacy)).toBe('ios')
    })

    it('tells a modern iPad apart from a Mac by touch points', () => {
        // iPadOS 13+ sends a desktop Safari user-agent identical to a Mac's.
        expect(detectPlatform(UA.macSafari, 5)).toBe('ios')
        expect(detectPlatform(UA.macSafari, 0)).toBe('macos')
    })

    it('prefers Android over the Linux token Android user-agents carry', () => {
        expect(detectPlatform(UA.android)).toBe('android')
    })

    it('recognises Windows', () => {
        expect(detectPlatform(UA.windowsChrome)).toBe('windows')
    })

    it('returns unknown for desktop Linux', () => {
        expect(detectPlatform(UA.linuxFirefox)).toBe('unknown')
    })
})

describe('canInstallExtension', () => {
    it('is true on desktops, including Linux reported as unknown', () => {
        expect(canInstallExtension('macos')).toBe(true)
        expect(canInstallExtension('windows')).toBe(true)
        expect(canInstallExtension('unknown')).toBe(true)
    })

    it('is false on phones and tablets, where no store sells an installable build', () => {
        expect(canInstallExtension('ios')).toBe(false)
        expect(canInstallExtension('android')).toBe(false)
    })
})

describe('detectBrowser', () => {
    it('tells Edge apart from Chrome even though Edge says Chrome', () => {
        expect(detectBrowser(UA.windowsEdge)).toBe('edge')
        expect(detectBrowser(UA.windowsChrome)).toBe('chrome')
    })

    it('tells Chrome apart from Safari even though Chrome says Safari', () => {
        expect(detectBrowser(UA.windowsChrome)).toBe('chrome')
        expect(detectBrowser(UA.macSafari)).toBe('safari')
    })

    it('recognises Firefox on desktop and on iOS', () => {
        expect(detectBrowser(UA.linuxFirefox)).toBe('firefox')
        expect(detectBrowser(UA.iosFirefox)).toBe('firefox')
    })

    it('recognises Chrome on iOS', () => {
        expect(detectBrowser(UA.iosChrome)).toBe('chrome')
    })

    it('reports Chromium browsers without a listing as chrome', () => {
        // Brave, Opera, Vivaldi and Arc all install from the Chrome Web Store
        // and carry a plain Chrome user-agent.
        expect(detectBrowser(UA.windowsChrome)).toBe('chrome')
    })
})
