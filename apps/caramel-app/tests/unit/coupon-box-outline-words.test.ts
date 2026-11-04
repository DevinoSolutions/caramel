import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { couponBoxCases } from '../../evals/fixtures/coupon-box-cases'
import {
    OUTLINE_WORDS,
    outlineWordsOnly,
} from '../../evals/fixtures/extension-outline-words'

// The extension keeps only the words on its fixed word list in an outline,
// so an eval fixture whose names carry another word is a page no shopper can
// send, and a server rule keyed on an unlisted word never fires. These tests
// pin the app's copy of that list (evals/fixtures/extension-outline-words.ts)
// to the extension's own, and the fixtures and the rules to the copy.

const EXTENSION_OUTLINE = readFileSync(
    new URL(
        '../../../caramel-extension/coupon-box-outline.js',
        import.meta.url,
    ),
    'utf8',
)

const extensionWords = () => {
    const m = /ALLOWED_WORDS = new Set\(\s*`([^`]*)`/.exec(EXTENSION_OUTLINE)
    if (!m) throw new Error('no ALLOWED_WORDS literal in coupon-box-outline.js')
    return new Set(m[1]!.split(/\s+/).filter(Boolean))
}

// caramelAllowedWords as the copy ports it, whitespace taken out.
const EXTENSION_FILTER =
    "exportfunctioncaramelAllowedWords(name){returnname.split(/\\s+/).filter(token=>{constletters=token.toLowerCase().replace(/[^\\p{L}]+/gu,'').trim()return(!letters||letters.split('').every(w=>ALLOWED_WORDS.has(w)))}).join('').trim()}"

describe('the app copy of the extension word list', () => {
    it('holds every word of the extension list', () => {
        const missing = Array.from(extensionWords()).filter(
            w => !OUTLINE_WORDS.has(w),
        )
        expect(missing).toEqual([])
    })

    it('holds no word the extension list lacks', () => {
        const ext = extensionWords()
        const extra = Array.from(OUTLINE_WORDS).filter(w => !ext.has(w))
        expect(extra).toEqual([])
    })

    it('filters names the way the extension does', () => {
        const m =
            /export function caramelAllowedWords\(name\) \{[\s\S]*?\n\}/.exec(
                EXTENSION_OUTLINE,
            )
        expect(m?.[0].replace(/\s+/g, '')).toBe(EXTENSION_FILTER)
        expect(outlineWordsOnly('Have a promo code? 4 Jane St')).toBe(
            'Have a promo code? 4',
        )
        expect(outlineWordsOnly('Bon de réduction')).toBe('Bon réduction')
        expect(outlineWordsOnly('#,### / *')).toBe('#,### / *')
    })
})

// A line's name, as the outline prints it.
const LINE_NAME = /^\s*- (?:\[\d+\] )?[a-z]+ "(.*)"(?: \[[a-z, ]+\])?:?$/

describe('the eval fixtures', () => {
    it('carry only names the extension can send', () => {
        const names = couponBoxCases.flatMap((c, i) =>
            c.outline.split('\n').flatMap(line => {
                const name = LINE_NAME.exec(line)?.[1]
                return name === undefined ? [] : [`#${i} ${c.store}: ${name}`]
            }),
        )
        // Every case's outline is read, not a lucky few.
        expect(names.length).toBeGreaterThan(couponBoxCases.length * 10)
        expect(
            names.filter(n => {
                const name = n.slice(n.indexOf(': ') + 2)
                return outlineWordsOnly(name) !== name
            }),
        ).toEqual([])
    })
})

// The words the server's rules (src/lib/couponBoxPick.ts) key on. A rule on a
// word the extension drops never fires on a real outline.
const RULE_WORDS = [
    // points, rewards and membership (LOYALTY)
    'redeem',
    'redemption',
    'point',
    'points',
    'reward',
    'rewards',
    'loyalty',
    'member',
    'members',
    'membership',
    'student',
    'students',
    'military',
    'teacher',
    'teachers',
    'verify',
    'verification',
    // store credit and gift cards (STORE_CREDIT, noCodeClick)
    'store',
    'credit',
    'balance',
    'gift',
    'card',
    'cards',
    'wrap',
    'message',
    // a code (NAMES_CODE, CODE_WORD, CODE_ENTRY_RE)
    'code',
    'codes',
    'coupon',
    'coupons',
    'voucher',
    'vouchers',
    'promo',
    'kod',
    'rabattkod',
    'kampanjkod',
    'gutschein',
    'bon',
    'réduction',
    'have',
    'got',
    'enter',
    'apply',
    'use',
    // offers and the small print (SAYS_OFFER, SAYS_DISCOUNT, ABOUT_TERMS)
    'discount',
    'offer',
    'offers',
    'deals',
    'save',
    'promotions',
    'details',
    'terms',
    'conditions',
    // never clicked (NEVER_CLICK, FORBIDDEN_CONTROL, NO_CODE_CLICK_RE)
    'checkout',
    'check',
    'out',
    'place',
    'order',
    'pay',
    'remove',
    'delete',
    'empty',
    'sign',
    'log',
    'continue',
    'proceed',
    'next',
    'buy',
    'purchase',
    'submit',
    'confirm',
    'protection',
    'warranty',
    'subscribe',
    'register',
    // the cart's own summary (CART_BUTTON, CART_SUMMARY)
    'subtotal',
    'summary',
]

describe('the server rules', () => {
    it('key on words the extension keeps', () => {
        expect(RULE_WORDS.filter(w => !OUTLINE_WORDS.has(w))).toEqual([])
    })
})
