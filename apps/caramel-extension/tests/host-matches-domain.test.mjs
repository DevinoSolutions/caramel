import { describe, expect, it } from 'vitest'
import { _hostMatchesDomain } from '../store-detect.js'

// Which hosts inherit a store's config and coupons. This is a security
// boundary as much as a feature: matching too loosely lets an attacker-
// registered host inherit a real brand's selectors and codes.
//
// The myshopify case (QA sweep 2026-08-05): 5starnutritionusa.com sends its
// checkout to 5starnutritionusa.myshopify.com. The extension went completely
// dark there — no prompt, no coupon fetch at all — at the one moment it
// matters, because nothing connected the two hosts.

describe('_hostMatchesDomain', () => {
    it('matches the store on its own domain and subdomains', () => {
        expect(_hostMatchesDomain('toms.com', 'toms.com')).toBe(true)
        expect(_hostMatchesDomain('www.toms.com', 'toms.com')).toBe(true)
        expect(_hostMatchesDomain('checkout.toms.com', 'toms.com')).toBe(true)
    })

    it('follows a Shopify store to its own myshopify checkout host', () => {
        // The reported failure, directly.
        expect(
            _hostMatchesDomain(
                '5starnutritionusa.myshopify.com',
                '5starnutritionusa.com',
            ),
        ).toBe(true)
    })

    it('does not let one store inherit another via a myshopify host', () => {
        expect(
            _hostMatchesDomain('someoneelse.myshopify.com', 'toms.com'),
        ).toBe(false)
        // Nested labels are not a shop host.
        expect(_hostMatchesDomain('evil.toms.myshopify.com', 'toms.com')).toBe(
            false,
        )
    })

    it('does not match bare myshopify.com against anything', () => {
        expect(_hostMatchesDomain('myshopify.com', 'toms.com')).toBe(false)
        expect(_hostMatchesDomain('.myshopify.com', 'toms.com')).toBe(false)
    })

    it('still refuses an attacker-registered look-alike', () => {
        // The rule this file's existing comment exists to enforce: a bare
        // "any prefix + hyphen" match would let evil-target.com inherit
        // target.com's selectors and coupons.
        expect(_hostMatchesDomain('evil-target.com', 'target.com')).toBe(false)
        expect(_hostMatchesDomain('nottoms.com', 'toms.com')).toBe(false)
        expect(_hostMatchesDomain('toms.com.evil.net', 'toms.com')).toBe(false)
    })

    it('still admits the allow-listed hyphen checkout prefixes', () => {
        // secure-athleta.gap.com is a real checkout host.
        expect(
            _hostMatchesDomain('secure-athleta.gap.com', 'athleta.gap.com'),
        ).toBe(true)
        // Under a two-label suffix too, when the store is a subdomain.
        expect(
            _hostMatchesDomain(
                'secure-shop.example.co.uk',
                'shop.example.co.uk',
            ),
        ).toBe(true)
    })

    it('a hyphen prefix on a registrable domain is a different domain, under a two-label suffix too', () => {
        // secure-emmabridgewater.co.uk is not emmabridgewater.co.uk's host:
        // anyone can register it. Neither is shop-shavershop.com.au.
        for (const [host, domain] of [
            ['secure-emmabridgewater.co.uk', 'www.emmabridgewater.co.uk'],
            ['secure-emmabridgewater.co.uk', 'emmabridgewater.co.uk'],
            ['shop-shavershop.com.au', 'www.shavershop.com.au'],
            ['checkout-allsaints.co.uk', 'allsaints.co.uk'],
            ['secure-target.com', 'target.com'],
        ])
            expect(_hostMatchesDomain(host, domain)).toBe(false)
        // Their real hosts still match.
        expect(
            _hostMatchesDomain(
                'checkout.emmabridgewater.co.uk',
                'www.emmabridgewater.co.uk',
            ),
        ).toBe(true)
    })

    it('a www. row names no Shopify shop', () => {
        expect(
            _hostMatchesDomain('usa.myshopify.com', 'www.usa.canon.com'),
        ).toBe(false)
        expect(
            _hostMatchesDomain('www.myshopify.com', 'www.acmetools.com'),
        ).toBe(false)
        expect(_hostMatchesDomain('usa.myshopify.com', 'usa.canon.com')).toBe(
            true,
        )
    })

    it('handles missing input without throwing', () => {
        expect(_hostMatchesDomain('', 'toms.com')).toBe(false)
        expect(_hostMatchesDomain('toms.com', '')).toBe(false)
        expect(_hostMatchesDomain(null, null)).toBe(false)
    })
})
