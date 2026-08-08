import { describe, expect, it } from 'vitest'
import { resolveStoreDomain } from '../../src/lib/storeDomain'

// Two hand-rolled copies of a "last two labels" base-domain helper used to
// collapse any three-label host onto its own public suffix:
//
//     mymemory.co.uk -> co.uk
//
// couponsRepo then matched `(site = 'co.uk' OR site LIKE '%.co.uk')`, i.e. the
// whole UK catalogue. Measured on 2026-08-05: a shopper buying a £29.99 USB
// stick on mymemory.co.uk was offered bareMinerals makeup codes, EVERY .co.uk
// and .com.au host returned the same mixed bucket (230 of 2,670 supported
// stores), and the invented domain notarealstore12345.co.uk returned 50
// coupons. The same helper fed /coupons/[store], so those rendered as
// indexable pages for a fictional store called "co.uk".

describe('resolveStoreDomain', () => {
    it('keeps the registrable label in front of a multi-label suffix', () => {
        // The bug, directly: this used to return "co.uk".
        expect(resolveStoreDomain('mymemory.co.uk')).toBe('mymemory.co.uk')
        expect(resolveStoreDomain('princesspolly.com.au')).toBe(
            'princesspolly.com.au',
        )
        expect(resolveStoreDomain('example.co.nz')).toBe('example.co.nz')
    })

    it('refuses a bare public suffix, which names no store', () => {
        // Returning "co.uk" here is what produced the 50-coupon response and
        // the fictional "co.uk" store page.
        expect(resolveStoreDomain('co.uk')).toBeNull()
        expect(resolveStoreDomain('com.au')).toBeNull()
        expect(resolveStoreDomain('com')).toBeNull()
    })

    it('still collapses subdomains onto the store, as before', () => {
        expect(resolveStoreDomain('shop.bombas.com')).toBe('bombas.com')
        expect(resolveStoreDomain('www.toms.com')).toBe('toms.com')
        expect(resolveStoreDomain('checkout.mymemory.co.uk')).toBe(
            'mymemory.co.uk',
        )
    })

    it('handles plain two-label domains unchanged', () => {
        expect(resolveStoreDomain('toms.com')).toBe('toms.com')
        expect(resolveStoreDomain('peets.com')).toBe('peets.com')
    })

    it('accepts a full URL as well as a bare host', () => {
        expect(resolveStoreDomain('https://www.mymemory.co.uk/cart')).toBe(
            'mymemory.co.uk',
        )
    })

    it('lower-cases so the catalogue matches regardless of input case', () => {
        // The served store list really does carry mixed-case entries.
        expect(resolveStoreDomain('eNasco.com')).toBe('enasco.com')
    })

    it('refuses input that is not a hostname at all', () => {
        // This value reaches a SQL LIKE pattern, so anything outside hostname
        // characters is rejected rather than sanitised.
        expect(
            resolveStoreDomain("bombas.com'; DROP TABLE coupons;--"),
        ).toBeNull()
        expect(resolveStoreDomain('')).toBeNull()
        expect(resolveStoreDomain('   ')).toBeNull()
        expect(resolveStoreDomain('not a domain')).toBeNull()
    })

    it('refuses hosts with no real public suffix', () => {
        expect(resolveStoreDomain('localhost')).toBeNull()
        expect(resolveStoreDomain('some-internal-box')).toBeNull()
    })

    it('resolves an unregistered domain to itself rather than to its suffix', () => {
        // notarealstore12345.co.uk is not a store we carry — but it must
        // resolve to ITSELF so the catalogue lookup returns nothing, instead
        // of resolving to "co.uk" and returning every UK coupon we hold.
        expect(resolveStoreDomain('notarealstore12345.co.uk')).toBe(
            'notarealstore12345.co.uk',
        )
    })
})
