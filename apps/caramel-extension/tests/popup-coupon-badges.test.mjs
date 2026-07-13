import { beforeAll, describe, expect, it } from 'vitest'
import { loadExtensionSource, loadExtensionSources } from './_load.mjs'

// F-006 — proves popup.js's badge label + restriction-warning rendering
// derives from window.CaramelCoupons.STATUS_META / RESTRICTED_STATUSES
// (coupon-constants.generated.js) end-to-end through the real
// renderCouponsView(), for one coupon per tier. A characterization that
// labels/behavior are UNCHANGED from the pre-F-006 hard-coded local BADGE
// map (PLAN-F-006.md: "extension: no behavior change").
let renderCouponsView

beforeAll(() => {
    document.body.innerHTML = '<div id="auth-container"></div>'
    // Real load order (manifest.json / manifest-firefox.json / index.html):
    // constants first, then the 6 F-008 split files (formerly
    // shared-utils.js; coupon-fetch.js's RESTRICTED_STATUSES rebind
    // consumes them eagerly at module-eval time), then popup.js.
    loadExtensionSource('coupon-constants.generated.js', [])
    loadExtensionSources(
        [
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
        ],
        [],
    )
    ;({ renderCouponsView } = loadExtensionSource('popup.js', [
        'renderCouponsView',
    ]))
})

const COUPONS = [
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

describe('popup.js renderCouponsView — badges + restriction banner (F-006)', () => {
    it('renders the correct label for one coupon per tier', () => {
        renderCouponsView(COUPONS, null, 'example.com')

        const html = document.getElementById('couponList').innerHTML
        expect(html).toContain('✓ Verified')
        expect(html).toContain('Restrictions apply')
        expect(html).toContain('Unverified')
        expect(html).toContain('Not valid')
    })

    it('flags only the restricted coupon with the restriction banner + item class; the dead one gets the dead class', () => {
        renderCouponsView(COUPONS, null, 'example.com')

        const items = document.querySelectorAll('#couponList .coupon-item')
        expect(items).toHaveLength(4)
        expect(items[0].className).not.toContain('coupon-item-restricted')
        expect(items[1].className).toContain('coupon-item-restricted')
        expect(items[1].innerHTML).toContain('coupon-restriction-text')
        expect(items[1].innerHTML).toContain('Only on select items')
        expect(items[3].className).toContain('coupon-item-dead')
    })
})
