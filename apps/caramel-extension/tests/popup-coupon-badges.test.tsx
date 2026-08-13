import { render } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import type { AppApi, Coupon } from '../entrypoints/popup/types'
import { CouponsView } from '../entrypoints/popup/views/CouponsView'

// F-006 — proves the coupon card's badge label + restriction-warning
// rendering derives from CaramelCoupons.STATUS_META / RESTRICTED_STATUSES
// (coupon-constants.generated.js) end-to-end through the real view, for one
// coupon per tier. A characterization that labels/behavior are UNCHANGED from
// the pre-F-006 hard-coded local BADGE map (PLAN-F-006.md: "extension: no
// behavior change").
//
// P2-ported 2026-08-13 from popup-coupon-badges.test.mjs: the vanilla suite
// drove renderCouponsView() and read #couponList.innerHTML; the same four
// facts are now read off the rendered React tree. The class names are the
// SAME ones styles.css targets — that contract did not move.

/** Permissive chrome stub — the makeChromeStub/installChromeStub pair the old
 * tests/_load.mjs harness installed around every eval: anything not
 * explicitly set answers with a callable no-op, storage callbacks fire the way
 * the real API does, and runtime.lastError starts UNDEFINED (a permissive
 * proxy would auto-create a truthy callable, which caramel-base.js reads as a
 * closed port). */
function installChromeStub() {
    const cache = new WeakMap()
    const wrap = (target: any): any => {
        if (cache.has(target)) return cache.get(target)
        const proxy = new Proxy(target, {
            get(obj: any, prop) {
                if (prop === 'then' || typeof prop === 'symbol')
                    return undefined
                if (!(prop in obj)) obj[prop] = wrap(function () {})
                return obj[prop]
            },
            apply: () => undefined,
        })
        cache.set(target, proxy)
        return proxy
    }
    const stub = wrap(function chromeStubRoot() {})
    for (const area of ['sync', 'local', 'session']) {
        stub.storage[area].get = (_keys: unknown, cb: any) => {
            if (typeof cb === 'function') cb({})
        }
        stub.storage[area].set = (_items: unknown, cb: any) => {
            if (typeof cb === 'function') cb()
        }
        stub.storage[area].remove = (_keys: unknown, cb: any) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    ;(globalThis as any).chrome = stub
    ;(globalThis as any).browser = undefined
    ;(window as any).chrome = stub
    ;(window as any).browser = undefined
    // Installed ONCE per suite file — vitest gives each file its own jsdom
    // window, so caramel-base.js's first-run bootstrap latch is still unset and
    // this stub really becomes the realm's currentBrowser.
    initCaramelBase()
    return stub
}

const makeApi = (): AppApi => ({
    openSignIn: vi.fn(),
    closeOverlay: vi.fn(),
    refresh: vi.fn(),
})

beforeAll(() => {
    // Real realm order (entrypoints/popup/main.tsx): constants published
    // first, then caramel-base's bootstrap binds the realm's chrome handle.
    initCouponConstants()
    installChromeStub()
})

const COUPONS: Coupon[] = [
    { code: 'GREEN10', title: 'Verified code', status: 'valid' },
    {
        code: 'AMBER10',
        title: 'Restricted code',
        status: 'product_restriction',
        verificationMessage: 'Only on select items',
    },
    { code: 'GREY10', title: 'Pending code', status: 'pending' },
    { code: 'RED10', title: 'Dead code', status: 'invalid' },
]

/** Four codes is under GUEST_COUPON_LIMIT, so the logged-out list here is the
 *  whole list — the guest gate has its own suite. */
const renderList = () =>
    render(
        <CouponsView
            coupons={COUPONS}
            user={null}
            domain="example.com"
            page={{ coupons: COUPONS }}
            api={makeApi()}
        />,
    )

describe('coupon card — badges + restriction banner (F-006)', () => {
    it('renders the correct label for one coupon per tier', () => {
        const { container } = renderList()

        const labels = [...container.querySelectorAll('.coupon-badge')].map(
            el => el.textContent,
        )
        expect(labels).toEqual([
            '✓ Verified',
            'Restrictions apply',
            'Unverified',
            'Not valid',
        ])
    })

    // UI modernization: tier colors moved from inline TIER_HEX styles onto
    // tokens-based .coupon-badge--<tier> classes (dark mode via tokens.css).
    // Pin the tier→class mapping and that no inline style remains, so the
    // token discipline can't silently regress back to hard-coded hexes.
    it('assigns tokens-based tier classes (no inline style) per STATUS_META tier', () => {
        const { container } = renderList()

        const badges = container.querySelectorAll('.coupon-badge')
        expect(badges).toHaveLength(4)
        expect(badges[0]!.className).toContain('coupon-badge--green')
        expect(badges[1]!.className).toContain('coupon-badge--amber')
        expect(badges[2]!.className).toContain('coupon-badge--grey')
        expect(badges[3]!.className).toContain('coupon-badge--red')
        for (const badge of badges) {
            expect(badge.getAttribute('style')).toBeNull()
        }
    })

    it('flags only the restricted coupon with the restriction banner + item class; the dead one gets the dead class', () => {
        const { container } = renderList()

        const items = container.querySelectorAll('.coupon-item')
        expect(items).toHaveLength(4)
        expect(items[0]!.className).not.toContain('coupon-item-restricted')
        expect(items[1]!.className).toContain('coupon-item-restricted')
        expect(
            items[1]!.querySelector('.coupon-restriction-text'),
        ).not.toBeNull()
        expect(items[1]!.textContent).toContain('Only on select items')
        // UI modernization: the ⚠ text glyph became an inline triangle-alert
        // SVG (stroke, currentColor).
        expect(
            items[1]!.querySelector('.coupon-restriction-icon svg'),
        ).not.toBeNull()
        expect(items[3]!.className).toContain('coupon-item-dead')
    })
})
