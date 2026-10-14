import { describe, expect, it } from 'vitest'
import {
    _CARAMEL_FINDER_NO_RE,
    _caramelFinderSaysNo,
    _caramelSaysAccepted,
    _caramelSentencesOf,
} from '../coupon-apply.js'

// Characterization of three text readers in coupon-apply.js that once leaned on
// regex lookbehind (`(?<!\bno )minimum`, `(?<!\b(zip|post(al)?|...)\s?)code`,
// `split(/(?<=[.!?])\s+|\n+/)`). Safari before 16.4 (macOS 13.0-13.3, inside
// the release workflow's deployment floor) has no lookbehind: a pattern with
// one throws a SyntaxError when the module loads and takes the whole content
// script down. These cases were recorded against the lookbehind versions
// first, then the readers were rewritten without lookbehind; they must stay
// green unchanged, which is what "same behaviour" means here.

describe('the finder refusal reader: "minimum", unless it is "no minimum"', () => {
    it.each([
        ['Minimum order of $50 required', true],
        ['A minimum purchase applies', true],
        ['minimum', true],
        ['No minimum order', false],
        ['Free shipping with NO minimum', false],
        ['no minimum', false],
        // "no " must start at a word boundary: "piano minimum" is not "no minimum".
        ['piano minimum', true],
        ['Piano Minimum', true],
        // exactly one space between "no" and the word.
        ['Orders with no  minimum', true],
        ['no\tminimum', true],
        ['nominimum', true],
        // any one unblocked "minimum" is enough.
        ['no minimum, but a minimum spend of $20', true],
        ['no minimum and no minimum', false],
        ['no minimuminimum', true],
        ['we have no minimum. Others have a minimum.', true],
        ['Cart is empty', false],
        ['', false],
    ])('%j -> %s', (text, expected) => {
        expect(_caramelFinderSaysNo(text)).toBe(expected)
    })

    it('reads a missing text as silence', () => {
        expect(_caramelFinderSaysNo(undefined)).toBe(false)
        expect(_caramelFinderSaysNo(null)).toBe(false)
    })
})

describe('the finder refusal reader: a form field error is not about a code', () => {
    it.each([
        ['Enter a valid email address', false],
        ['Enter a valid code', true],
        ['Enter a valid zip code', false],
        ['Enter a valid Zip Code', false],
        ['Invalid zip codes', false],
        ['Invalid postal code', false],
        ['Invalid post code', false],
        ['Invalid area code (phone)', false],
        ['Invalid country code and phone number', false],
        ['Invalid security code for your card number', false],
        ['Invalid sms code, check your phone', false],
        ['Invalid sort code on this address', false],
        ['Invalid access code, check your email', false],
        ['Invalid verification code sent to your email', false],
        // one whitespace between the qualifier and "code", no more, no less.
        ['Invalid zip  code', true],
        ['Invalid zip\ncode', false],
        ['Invalid zip. code', true],
        // no word boundary inside "zipcode": not a form-field message at all.
        ['Invalid zipcode', true],
        ['Invalid phone code', true],
        // a qualifier must start at a word boundary.
        ['Invalid bzip code', true],
        // other coupon words rescue a field message.
        ['Invalid zip code or discount', true],
        ['Invalid email. Use promo code', true],
        ['Invalid email and zip code, promo codes', true],
        ['Invalid email, gift card or voucher', true],
        ['Invalid email, offers inside', true],
        ['Invalid email, hot offerings', false],
    ])('%j -> %s', (text, expected) => {
        expect(_caramelFinderSaysNo(text)).toBe(expected)
    })
})

describe('the accepted-code reader needs a sentence about a code', () => {
    it.each([
        ['Code SAVE10 applied', '', true],
        ['Discount applied', '', true],
        ['Promo accepted', '', true],
        ['Free shipping applied', '', false],
        ['Item added to cart', '', false],
        // a sentence about a form-field code is not about a coupon.
        ['Zip code applied', '', false],
        ['Security code accepted', '', false],
        // sentences are whitespace-collapsed first, so this is "Postal code".
        ['Postal  code applied', '', false],
        ['Your code was not applied', '', false],
        // a sentence already on the page before submitting does not count.
        ['Promo code applied.', 'Promo code applied.', false],
        ['Item added. Promo code applied.', 'Item added.', true],
        ['Item added.\nPromo code applied.', 'Item added.', true],
        ['Promo code applied.', 'Item added.', true],
    ])('%j after %j -> %s', (text, before, expected) => {
        expect(_caramelSaysAccepted(text, before)).toBe(expected)
    })
})

describe('splitting text into sentences', () => {
    it.each([
        [
            'Hello world. Second one! Third? Fourth',
            ['Hello world.', 'Second one!', 'Third?', 'Fourth'],
        ],
        ['a.b c', ['a.b c']],
        [
            'Line one\nLine two\n\n  Line three',
            ['Line one', 'Line two', 'Line three'],
        ],
        ['Wait...  really?!   yes', ['Wait...', 'really?!', 'yes']],
        ['A.\n\nB.', ['A.', 'B.']],
        ['x. \n y', ['x.', 'y']],
        ['A \n B', ['A', 'B']],
        ['no break here  with   spaces', ['no break here with spaces']],
        ['end.   ', ['end.']],
        ['3.5 stars. ok', ['3.5 stars.', 'ok']],
        ['e.g.foo bar', ['e.g.foo bar']],
        ['a\r\nb', ['a', 'b']],
        ['Hi.\tthere', ['Hi.', 'there']],
        ['a! b', ['a!', 'b']],
        ['.', ['.']],
        ['. .', ['.', '.']],
        ['   ', []],
        ['', []],
    ])('%j', (text, expected) => {
        expect(_caramelSentencesOf(text)).toEqual(expected)
    })

    it('reads a missing text as no sentences', () => {
        expect(_caramelSentencesOf(undefined)).toEqual([])
        expect(_caramelSentencesOf(null)).toEqual([])
    })
})

// The lookbehind originals, kept here as an oracle. Node has lookbehind, so
// this file can hold what the shipped script no longer may; the rewritten
// readers must agree with them on every string in a fixed, generated corpus
// (every sequence of up to three tokens, then 30000 seeded longer ones).
describe('equivalence with the lookbehind originals', () => {
    const ORIGINAL_NO_RE = new RegExp(
        _CARAMEL_FINDER_NO_RE.source + String.raw`|(?<!\bno )minimum`,
        'i',
    )
    const ORIGINAL_COUPON_WORD_RE =
        /(?<!\b(zip|post(al)?|area|country|security|verification|sort|sms|access)\s?)\bcodes?\b|coupon|promo|discount|voucher|\boffers?\b|gift ?card/i
    const FIELD_RE =
        /\b(e-?mail|password|phone|zip|post ?code|postal|address|card number|cvv)\b/i
    const originalSaysNo = text => {
        const t = text || ''
        return (
            ORIGINAL_NO_RE.test(t) &&
            !(FIELD_RE.test(t) && !ORIGINAL_COUPON_WORD_RE.test(t))
        )
    }
    const originalSentences = text =>
        (text || '')
            .split(/(?<=[.!?])\s+|\n+/)
            .map(s => s.trim().replace(/\s+/g, ' '))
            .filter(Boolean)

    const TOKENS = [
        'no',
        'No',
        'minimum',
        'Minimum',
        'minimuminimum',
        'piano',
        'zip',
        'post',
        'postal',
        'access',
        'code',
        'codes',
        'Code',
        'zipcode',
        'invalid',
        'not valid',
        'coupon',
        'promo',
        'offer',
        'email',
        'phone',
        'x',
        '3.5',
        ' ',
        '  ',
        '\t',
        '\n',
        ' ',
        '.',
        '!',
        '?',
        '...',
    ]

    function* corpus() {
        yield ''
        for (const a of TOKENS) {
            yield a
            for (const b of TOKENS) {
                yield a + b
                yield a + ' ' + b
                for (const c of TOKENS) {
                    yield a + b + c
                    yield a + ' ' + b + ' ' + c
                }
            }
        }
        // mulberry32: a fixed seed, so a failure reproduces.
        let seed = 0x5eed
        const next = () => {
            seed = (seed + 0x6d2b79f5) | 0
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        }
        for (let i = 0; i < 30000; i++) {
            const length = 4 + Math.floor(next() * 7)
            let text = ''
            for (let j = 0; j < length; j++) {
                text += TOKENS[Math.floor(next() * TOKENS.length)]
                if (next() < 0.5) text += ' '
            }
            yield text
        }
    }

    it('reads "no minimum", form-field codes and coupon words as the original did', () => {
        let compared = 0
        for (const text of corpus()) {
            const expected = originalSaysNo(text)
            if (_caramelFinderSaysNo(text) !== expected) {
                expect.fail(
                    `finder refusal reader disagrees on ${JSON.stringify(text)}: original ${expected}`,
                )
            }
            compared++
        }
        expect(compared).toBeGreaterThan(30000)
    })

    it('splits sentences as the original did', () => {
        for (const text of corpus()) {
            const expected = originalSentences(text)
            const actual = _caramelSentencesOf(text)
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                expect.fail(
                    `sentence splitter disagrees on ${JSON.stringify(text)}: original ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
                )
            }
        }
    })
})
