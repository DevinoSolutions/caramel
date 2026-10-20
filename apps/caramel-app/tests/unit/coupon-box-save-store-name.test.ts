import { describe, expect, it } from 'vitest'

import {
    pickSaveStoreName,
    storeConfigFromBox,
    storeNameCandidates,
} from '@/lib/couponBoxSave'

// Which store a saved box is filed under (couponBoxSave.ts): only names whose
// row the extension would apply on the same host (store-detect.js
// _hostMatchesDomain + getDomainRecord's ranking), so the box that worked is
// the box the next shopper gets.

const sorted = (names: string[]) => [...names].sort()

describe('storeNameCandidates', () => {
    it('the host and each parent down to its registrable domain, each with a www. twin', () => {
        expect(
            sorted(storeNameCandidates('checkout.shop.example.com').names),
        ).toEqual(
            sorted([
                'checkout.shop.example.com',
                'www.checkout.shop.example.com',
                'shop.example.com',
                'www.shop.example.com',
                'example.com',
                'www.example.com',
            ]),
        )
    })

    it('never climbs past the registrable domain to a public suffix', () => {
        const { names } = storeNameCandidates('www.example.co.uk')
        expect(names).toContain('example.co.uk')
        expect(names).not.toContain('co.uk')
        expect(names).not.toContain('www.co.uk')
    })

    it('a hyphen checkout host names the store behind it only below its registrable domain (the extension rule)', () => {
        expect(storeNameCandidates('secure-athleta.gap.com').names).toContain(
            'athleta.gap.com',
        )
        // secure-target.com is a domain anyone can buy: never target.com's.
        expect(storeNameCandidates('secure-target.com').names).not.toContain(
            'target.com',
        )
        // Not an allow-listed prefix.
        expect(storeNameCandidates('evil-athleta.gap.com').names).not.toContain(
            'athleta.gap.com',
        )
    })

    it('a myshopify host is its own name plus the shop label, never myshopify.com', () => {
        const { names, shopLabel } = storeNameCandidates('brand.myshopify.com')
        expect(sorted(names)).toEqual(
            sorted(['brand.myshopify.com', 'www.brand.myshopify.com']),
        )
        expect(shopLabel).toBe('brand')
    })

    it('a host that names no store has no candidates', () => {
        expect(storeNameCandidates('localhost').names).toEqual([])
        expect(storeNameCandidates('co.uk').names).toEqual([])
    })
})

describe('pickSaveStoreName', () => {
    it('the most specific known name wins (oldnavy.gap.com over gap.com)', () => {
        const direct = storeNameCandidates('www.oldnavy.gap.com').names
        expect(pickSaveStoreName(direct, ['gap.com', 'oldnavy.gap.com'])).toBe(
            'oldnavy.gap.com',
        )
    })

    it('a bare name beats its www. twin; a www.-only store keeps its own name', () => {
        const direct = storeNameCandidates('www.example.com').names
        expect(
            pickSaveStoreName(direct, ['www.example.com', 'example.com']),
        ).toBe('example.com')
        expect(pickSaveStoreName(direct, ['www.example.com'])).toBe(
            'www.example.com',
        )
    })

    it('a shop-label match counts only when nothing matched directly and it is the only one', () => {
        const direct = storeNameCandidates('brand.myshopify.com').names
        expect(pickSaveStoreName(direct, ['brand.com'])).toBe('brand.com')
        // The label says nothing about which of the two it is.
        expect(pickSaveStoreName(direct, ['brand.com', 'brand.com.au'])).toBe(
            null,
        )
        expect(
            pickSaveStoreName(direct, ['brand.myshopify.com', 'brand.com']),
        ).toBe('brand.myshopify.com')
    })

    it('nothing known: null', () => {
        expect(pickSaveStoreName(['example.com'], [])).toBe(null)
    })
})

describe('storeConfigFromBox', () => {
    it('maps the box onto the contract columns (apply ?? input)', () => {
        expect(
            storeConfigFromBox('example.com', {
                input: '#code',
                apply: null,
                toggle: '.have-code',
                total: null,
            }),
        ).toEqual({
            storeName: 'example.com',
            couponInputXpath: '#code',
            applyButtonXpath: '#code',
            showInputXpath: '.have-code',
            priceContainerXpath: null,
        })
    })
})
