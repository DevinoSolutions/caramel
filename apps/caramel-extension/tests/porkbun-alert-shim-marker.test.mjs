import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    CARAMEL_CAPABILITY_MARKERS,
    caramelCapabilityHeld,
} from '../extension-capabilities.js'
import { installPorkbunAlertShim } from '../porkbun-alert-shim.js'

// The content realm decides whether porkbun.com may be auto-applied by reading
// the marker this helper stamps. The DOM is shared between worlds, so the
// marker is only honest if it is stamped from the PAGE's world: a browser that
// ignores `world: 'MAIN'` runs this same code in the isolated world, where the
// page's own handler (processApplyCartCoupon) does not exist and the alert
// wrapper changes nothing the page can see.

const MARKER = CARAMEL_CAPABILITY_MARKERS.alertShim

let uninstall = () => {}

afterEach(() => {
    uninstall()
    uninstall = () => {}
    delete window.processApplyCartCoupon
    document.documentElement.removeAttribute(MARKER)
})

describe('porkbun alert shim capability marker', () => {
    it('stamps <html> once installed in the page world, and removes it on uninstall', () => {
        window.alert = vi.fn()
        window.processApplyCartCoupon = () => {}
        expect(caramelCapabilityHeld('alertShim')).toBe(false)

        uninstall = installPorkbunAlertShim(window)
        expect(caramelCapabilityHeld('alertShim')).toBe(true)

        uninstall()
        expect(caramelCapabilityHeld('alertShim')).toBe(false)
    })

    it('does NOT stamp where the page handler is invisible (isolated world)', () => {
        window.alert = vi.fn()
        uninstall = installPorkbunAlertShim(window)
        window.dispatchEvent(new Event('load'))

        expect(caramelCapabilityHeld('alertShim')).toBe(false)
    })

    it('stamps at load when the handler arrives after parsing', () => {
        window.alert = vi.fn()
        uninstall = installPorkbunAlertShim(window)
        expect(caramelCapabilityHeld('alertShim')).toBe(false)

        window.processApplyCartCoupon = () => {}
        window.dispatchEvent(new Event('load'))

        expect(caramelCapabilityHeld('alertShim')).toBe(true)
    })

    it('waits for DOMContentLoaded while the document is still loading', () => {
        const handlers = []
        const html = document.createElement('html')
        const fakeDoc = {
            readyState: 'loading',
            documentElement: html,
            addEventListener: (type, fn) => handlers.push([type, fn]),
            removeEventListener: () => {},
        }
        const fakeWin = {
            alert: vi.fn(),
            document: fakeDoc,
            processApplyCartCoupon: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
        }
        installPorkbunAlertShim(fakeWin)

        expect(html.getAttribute(MARKER)).toBeNull()
        handlers.find(([type]) => type === 'DOMContentLoaded')[1]()
        expect(html.getAttribute(MARKER)).toBe('1')
    })
})
