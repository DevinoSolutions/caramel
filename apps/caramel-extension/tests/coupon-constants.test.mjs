import { describe, expect, it } from 'vitest'
import { loadExtensionSource, loadExtensionSources } from './_load.mjs'

// F-006 — proves the extension's app<->shared coupon-domain wiring works,
// not just that the generated file has the right JSON shape (that's
// coupon-constants.generated.test.ts's job, app-side).

describe('coupon-constants.generated.js -> window.CaramelCoupons', () => {
    it('sets the 4 expected keys with the real vocabulary counts (9 statuses, 7 visible, 4 restricted)', () => {
        loadExtensionSource('coupon-constants.generated.js', [])

        expect(window.CaramelCoupons.STATUSES).toHaveLength(9)
        expect(window.CaramelCoupons.VISIBLE_STATUSES).toHaveLength(7)
        expect(window.CaramelCoupons.RESTRICTED_STATUSES).toHaveLength(4)
        expect(Object.keys(window.CaramelCoupons.STATUS_META)).toHaveLength(9)
        expect(window.CaramelCoupons.STATUS_META.valid).toEqual({
            label: '✓ Verified',
            tier: 'green',
        })
    })
})

describe("coupon-fetch.js RESTRICTED_STATUSES (formerly shared-utils.js, split by F-008) — genuinely SOURCED FROM window.CaramelCoupons (F-006's 1-line rebind), not a coincidentally-matching hard-coded literal", () => {
    it('reflects a deliberately different fixture set before coupon-fetch.js loads', () => {
        loadExtensionSource('coupon-constants.generated.js', [])
        // Overwrite with an obviously-fake fixture BEFORE the F-008 split
        // files load. If RESTRICTED_STATUSES were still hard-coded (the
        // pre-F-006 state), it would ignore this entirely and keep the real
        // 4-status set — this is what would fail if the rebind ever
        // regressed back to a literal.
        window.CaramelCoupons.RESTRICTED_STATUSES = ['totally_fake_status']

        const { RESTRICTED_STATUSES } = loadExtensionSources(
            [
                'caramel-base.js',
                'dom-utils.js',
                'store-detect.js',
                'coupon-apply.js',
                'coupon-fetch.js',
                'coupon-runner.js',
            ],
            ['RESTRICTED_STATUSES'],
        )

        expect(RESTRICTED_STATUSES instanceof Set).toBe(true)
        expect(RESTRICTED_STATUSES.has('totally_fake_status')).toBe(true)
        expect(RESTRICTED_STATUSES.has('product_restriction')).toBe(false)
    })
})
