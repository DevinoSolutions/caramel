import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// The restore step destroyed a discount that had never been in danger, and then
// reported that it had saved it.
//
// Live on harney.com, 2026-08-06, reproduced twice. The shopper arrived with
// their own HARNEY10 taking $10.00 off a $111.00 cart. The flow probed eight
// catalogue codes; every one failed, and HARNEY10 was STILL live and still
// worth $10.00 sixteen seconds in. The restore step then re-applied it anyway —
// and that is what killed it: the cart went to discount 0 with HARNEY10 sitting
// last and inapplicable. The log read
//   AUTO_INSERT_RESTORED_EXISTING {code: HARNEY10, restored: true, total: 11100}
// where 11100 is the UNDISCOUNTED total the same run had already recorded as
// 10100 with the discount on. `restored: true` was asserted from the re-apply
// REQUEST succeeding; the number that disproved it was in the same log line.
// The shopper was then shown "HARNEY10 is already applied and saving you
// $10.00" over a cart with no discount at all.
//
// The cart model below is not invented. It is what /discount/{code} was
// measured doing on a real harney.com cart in one session:
//
//   seed                      -> {"discount":0,"codes":[]}
//   /discount/HARNEY10        -> {"discount":1000,"codes":["HARNEY10"]}
//   7 failing catalogue codes -> {"discount":1000,"codes":["HARNEY10","MAR26(dead)",…]}
//   /discount/HARNEY10 again  -> {"discount":0,"codes":["MAR26(dead)",…,"HARNEY10(dead)"]}
//   /discount/HARNEY10 again  -> unchanged: dead. Deterministic, not a race.
//   POST /cart/update.js {discount:""} -> {"discount":0,"codes":[]}
//   /discount/HARNEY10        -> {"discount":1000,"codes":["HARNEY10"]}  (full value back)
//
// So the endpoint APPENDS rather than replaces, and re-sending a code the cart
// already holds demotes it to the end of the list and kills it. Clearing first
// is what makes a restore that IS needed actually work.

let startApplyingCoupons
let _caramelLiveDiscountFor

let finalModals
let sent
let cleared
let cart

// Domain only: there is no promo box anywhere in this file and no config
// selector for one. Everything below is the discount-link path, which is pure
// cart payload — /cart.js in, /discount/{code} and /cart/update.js out. Nothing
// here fabricates a form, and nothing here would notice if a store had one. The
// DOM stubs the form path needs (waitForElement, applyCoupon) are deliberately
// absent, so a test that ever reached that path would throw rather than quietly
// measure a page that doesn't exist.
const REC = { domain: 'shop.example' }

/** A cart that behaves the way harney.com's did, measured above. */
function makeCart({ subtotal, worth }) {
    const codes = [] // [{ code, dead }]
    const value = () => {
        const live = codes.find(c => !c.dead)
        return live ? worth[live.code] || 0 : 0
    }
    return {
        read() {
            const discount = value()
            return {
                token: 't',
                item_count: 2,
                currency: 'USD',
                total_price: subtotal - discount,
                total_discount: discount,
                discount_codes: codes.map(c => ({
                    code: c.code,
                    applicable: !c.dead,
                })),
                cart_level_discount_applications: codes
                    .filter(c => !c.dead)
                    .map(c => ({
                        title: c.code,
                        total_allocated_amount: worth[c.code] || 0,
                    })),
            }
        },
        apply(code) {
            const already = codes.findIndex(c => c.code === code)
            if (already >= 0) {
                // Re-sending an attached code moves it to the end, dead.
                codes.splice(already, 1)
                codes.push({ code, dead: true })
            } else if (worth[code] > 0) {
                for (const c of codes) c.dead = true
                codes.push({ code, dead: false })
            } else {
                codes.push({ code, dead: true })
            }
        },
        clear() {
            codes.length = 0
        },
        codes,
    }
}

beforeAll(() => {
    ;({ startApplyingCoupons, _caramelLiveDiscountFor } = loadExtensionSources(
        [
            'coupon-constants.generated.js',
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
        ],
        ['startApplyingCoupons', '_caramelLiveDiscountFor'],
    ))
})

/** Wires the runner onto `cart`, so every read is the cart's real state. */
function useCart(c, coupons) {
    cart = c
    globalThis.getCachedCodes = async () => coupons
    globalThis.fetchCoupons = async () => coupons
    globalThis.probeCartJson = async () => cart.read()
    globalThis.applyViaDiscountLink = async code => {
        sent.push(code)
        cart.apply(code)
        return cart.read()
    }
    // The clear is a raw endpoint call in coupon-apply.js; stub the endpoint,
    // not the function, so the test still exercises the real code path.
    globalThis.fetch = async (url, opts) => {
        if (String(url).includes('/cart/update.js')) {
            cleared.push(JSON.parse(opts?.body || '{}'))
            cart.clear()
            return { ok: true }
        }
        return { ok: false, status: 404 }
    }
}

beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
    finalModals = []
    sent = []
    cleared = []
    globalThis._caramelCodes = null
    globalThis.showFinalModal = (...a) => finalModals.push(a)
    globalThis.showTestingModal = async () => {}
    globalThis.updateTestingModal = async () => {}
    globalThis.hideTestingModal = () => {}
    globalThis.reportOutcome = () => {}
    globalThis.caramelRecordSaving = () => {}
})

const message = () => finalModals[0]?.[2] || ''
const listed = () => (finalModals[0]?.[4] || []).map(c => c.code)

describe('the shopper arrived with a code and none of ours beat it', () => {
    // harney.com: eight catalogue codes, seven of them dead, HARNEY10 theirs.
    const CATALOGUE = [
        { code: 'MAR26', id: 'm1' },
        { code: 'SNOW26', id: 's1' },
        { code: 'HEMP23', id: 'h1' },
        { code: 'BREAKFAST23', id: 'b1' },
    ]

    describe('and their code came through the probes untouched', () => {
        beforeEach(() => {
            const c = makeCart({ subtotal: 11100, worth: { HARNEY10: 1000 } })
            c.apply('HARNEY10')
            useCart(c, CATALOGUE)
        })

        it('leaves the discount they arrived with exactly where it was', async () => {
            await startApplyingCoupons(REC)

            expect(cart.read().total_discount).toBe(1000)
        })

        it('never re-sends the code that is already working', async () => {
            // This is the whole bug: the re-apply IS the destruction.
            await startApplyingCoupons(REC)

            expect(sent).not.toContain('HARNEY10')
        })

        it('tells them their code is still applied, with the real amount', async () => {
            await startApplyingCoupons(REC)

            expect(message()).toContain('HARNEY10')
            expect(message()).toContain('10.00')
            expect(message()).toContain('already applied')
        })

        it('keeps their live code out of the copy list', async () => {
            // Pasting it back in is now known to remove it.
            await startApplyingCoupons(REC)

            expect(listed()).not.toContain('HARNEY10')
        })
    })

    describe('and a probe knocked their code off the cart', () => {
        // goodr.com's shape: one of ours is genuinely applicable, just worth
        // less, so it demotes theirs without ever beating it. The restore is
        // real work here and must still happen.
        beforeEach(() => {
            const c = makeCart({
                subtotal: 11100,
                worth: { BOLDERBOULDER15: 800, SNOW26: 300 },
            })
            c.apply('BOLDERBOULDER15')
            useCart(c, CATALOGUE)
        })

        it('puts their discount back on the cart', async () => {
            await startApplyingCoupons(REC)

            expect(cart.read().total_discount).toBe(800)
        })

        it('clears and retries when the plain re-apply lands dead', async () => {
            await startApplyingCoupons(REC)

            expect(cleared).toContainEqual({ discount: '' })
        })

        it('says it put their code back, not that it was never gone', async () => {
            await startApplyingCoupons(REC)

            expect(message()).toContain('BOLDERBOULDER15')
            expect(message()).toContain('8.00')
        })
    })

    describe('and their code will not go back on', () => {
        beforeEach(() => {
            // They arrive with THEIRS live. SNOW26 is genuinely applicable and
            // knocks it off during probing, but is worth less, so nothing wins
            // and the restore is real work. The store then takes the restore
            // request and honours nothing — an expired code, a per-session
            // limit — which is the case `restored: !!restored` called a
            // success because the HTTP request came back fine.
            const c = makeCart({
                subtotal: 11100,
                worth: { THEIRS: 1000, SNOW26: 300 },
            })
            c.apply('THEIRS')
            useCart(c, CATALOGUE)
            const realApply = globalThis.applyViaDiscountLink
            globalThis.applyViaDiscountLink = async code => {
                if (code === 'THEIRS') {
                    sent.push(code)
                    return cart.read() // request "succeeded", nothing applied
                }
                return realApply(code)
            }
        })

        it('never claims a saving the cart cannot show', async () => {
            await startApplyingCoupons(REC)

            expect(message()).not.toContain('already applied')
            expect(message()).not.toContain('saving you')
        })

        it('tells them to paste their own code back in', async () => {
            await startApplyingCoupons(REC)

            expect(message()).toContain('THEIRS')
            expect(message().toLowerCase()).toMatch(/paste|check ?out/)
        })

        it('offers their code first, even though it is not one of ours', async () => {
            // It is the one code we know was working on this cart, and the
            // catalogue filter would never surface it.
            await startApplyingCoupons(REC)

            expect(listed()[0]).toBe('THEIRS')
        })
    })
})

describe('_caramelLiveDiscountFor', () => {
    const CART = {
        currency: 'USD',
        total_discount: 1000,
        discount_codes: [
            { code: 'DEADONE', applicable: false },
            { code: 'HARNEY10', applicable: true },
        ],
        cart_level_discount_applications: [
            { title: 'HARNEY10', total_allocated_amount: 1000 },
        ],
    }

    it('reports what a live code is worth right now', () => {
        expect(_caramelLiveDiscountFor(CART, 'HARNEY10')).toBe(1000)
    })

    it('reports nothing for a code the platform demoted', () => {
        // The exact state the harney restore produced, and the state the old
        // code called `restored: true`.
        expect(
            _caramelLiveDiscountFor(
                {
                    ...CART,
                    total_discount: 0,
                    discount_codes: [{ code: 'HARNEY10', applicable: false }],
                    cart_level_discount_applications: [],
                },
                'HARNEY10',
            ),
        ).toBe(0)
    })

    it('reports nothing for a code that is not on the cart at all', () => {
        expect(_caramelLiveDiscountFor(CART, 'NEVERSENT')).toBe(0)
    })

    it('matches case-insensitively, because payloads are inconsistent', () => {
        expect(_caramelLiveDiscountFor(CART, 'harney10')).toBe(1000)
    })

    it('survives a cart it could not read', () => {
        expect(_caramelLiveDiscountFor(null, 'HARNEY10')).toBe(0)
        expect(_caramelLiveDiscountFor({}, 'HARNEY10')).toBe(0)
    })
})
