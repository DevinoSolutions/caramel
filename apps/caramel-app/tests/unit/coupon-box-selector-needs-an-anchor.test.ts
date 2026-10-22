import { isCouponBoxSelector } from '@/lib/couponBoxSelector'
import { describe, expect, it } from 'vitest'

// A selector the server stores as a store's coupon box must name one
// element. A compound of only bare types or `*` cannot: `*` is `<html>` under
// querySelector and `input` is the page's first field (often the site
// search). The extension's own emitter (caramelStableSelector,
// coupon-box-selectors.js) always anchors on an id, class or attribute, so a
// selector with none of those can only come from a buggy or forged client.
// The grammar (couponBoxSelector.ts isAnchored) refuses it. A `#`, `.` or
// `[` inside `:not(...)` does not count as an anchor.

describe('selectors that cannot name a coupon box', () => {
    it.each([
        '*',
        'input',
        'div > input',
        '* > input',
        'input:not(*)',
        'form input',
        '*:first-child',
    ])('refuses %s (no id, class or attribute anywhere)', selector => {
        expect(isCouponBoxSelector(selector)).toBe(false)
    })
})
