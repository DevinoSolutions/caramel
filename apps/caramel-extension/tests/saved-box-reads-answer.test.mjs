import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { applyCoupon } from '../coupon-apply.js'
import {
    PROMO_BOX,
    TOTAL,
    installChromeStub,
    setPath,
    stubLayout,
} from './_found-box-harness.mjs'

// A box the extension found and saved for its store comes back in the feed as
// an ordinary config marked `savedBox` (supportedStoresCache.ts). It names no
// place where the store answers. Measured on bumbleandbumble.com (2026-10-22):
// read as a plain config, a refused code waited the full 10s and was quoted
// with the Apply button's label ("apply. The offer code newbbwelcome15 is not
// valid."). A saved box's answer is now read the way a found box's is.

vi.mock('../UI-helpers.js', async importOriginal => ({
    ...(await importOriginal()),
    showFinalModal: () => {},
    showTestingModal: async () => {},
    updateTestingModal: async () => {},
    hideTestingModal: () => {},
    insertCaramelPrompt: () => {},
}))
vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        get currentBrowser() {
            return actual.currentBrowser
        },
        caramelRecordSaving: () => {},
        log: () => {},
    }
})

const SLOW = 20000
const REFUSAL = 'The offer code BAD15 is not valid.'

const config = extra => ({
    domain: 'shop.test',
    couponInput: '#dc',
    couponSubmit: '#ap',
    priceContainer: '#tot',
    ...extra,
})
const SAVED = config({ savedBox: true })

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
})

beforeEach(() => {
    sessionStorage.clear()
    setPath('/cart')
    document.body.innerHTML =
        '<div id="banner" role="alert"></div>' + PROMO_BOX + TOTAL
})

// The store's answer, drawn under the box a moment after Apply.
function storeSaysBesideTheBox(text, ms = 150) {
    document.getElementById('ap').addEventListener('click', () =>
        setTimeout(() => {
            const p = document.createElement('p')
            p.className = 'msg'
            p.textContent = text
            document.querySelector('.promo').appendChild(p)
        }, ms),
    )
}

async function timed(code, rec) {
    const startedAt = performance.now()
    const res = await applyCoupon(code, rec)
    return { res, ms: performance.now() - startedAt }
}

describe('a saved box: the store refusing a code', () => {
    it(
        'is read when the store says it, and quoted without the box around it',
        async () => {
            storeSaysBesideTheBox(REFUSAL)

            const { res, ms } = await timed('BAD15', SAVED)

            expect(res.success).toBe(false)
            expect(res.errorMsg).toBe(REFUSAL)
            expect(res.errorIsNew).toBe(true)
            expect(ms).toBeLessThan(4000)
        },
        SLOW,
    )

    it(
        'the same page read as a plain config still waits the whole window (the measured defect)',
        async () => {
            storeSaysBesideTheBox(REFUSAL)

            const { res, ms } = await timed('BAD15', config())

            expect(res.success).toBe(false)
            expect(ms).toBeGreaterThan(9000)
            // The plain reader quotes a window around the words: the field's
            // label and the Apply button come with it.
            expect(res.errorMsg).not.toBe(REFUSAL)
            expect(res.errorMsg).toContain('Apply')
        },
        SLOW,
    )

    it(
        'is read from a page banner when the store answers there',
        async () => {
            document.getElementById('ap').addEventListener('click', () =>
                setTimeout(() => {
                    document.getElementById('banner').textContent = REFUSAL
                }, 150),
            )

            const { res, ms } = await timed('BAD15', SAVED)

            expect(res.success).toBe(false)
            expect(res.errorMsg).toBe(REFUSAL)
            expect(ms).toBeLessThan(4000)
        },
        SLOW,
    )

    it(
        'a refusal already showing before the submit does not end the wait',
        async () => {
            const old = document.createElement('p')
            old.textContent = REFUSAL
            document.querySelector('.promo').appendChild(old)

            const { res, ms } = await timed('BAD15', SAVED)

            expect(res.success).toBe(false)
            expect(res.errorIsNew).toBe(false)
            expect(ms).toBeGreaterThan(9000)
        },
        SLOW,
    )
})

// bumbleandbumble.com's cart, measured live 2026-10-22: the fieldset around
// the box always reads a refusal-shaped sentence ("Discount codes cannot be
// combined…"), and the store's answer is drawn in a message two levels above
// the form. The reader used to stop at the first sentence it met, the standing
// one, and never saw the answer.
describe('a saved box whose fieldset always carries a refusal-shaped line', () => {
    const STANDING =
        'Discount codes cannot be combined with other discount codes.'
    const SAID = 'The offer code newbbwelcome15 is not valid.'
    beforeEach(() => {
        document.body.innerHTML =
            '<div class="panel"><div class="content">' +
            '<form id="offer_code"><fieldset>' +
            '<div class="form-item"><input id="dc" type="text"></div>' +
            '<button id="ap" type="button">Apply</button>' +
            `<span class="offer-limit">${STANDING}</span>` +
            '</fieldset></form>' +
            '<div id="messages"></div>' +
            '</div></div>' +
            TOTAL
        document.getElementById('ap').addEventListener('click', () =>
            setTimeout(() => {
                const m = document.createElement('div')
                m.className = 'single-message'
                m.textContent = SAID
                document.getElementById('messages').appendChild(m)
            }, 150),
        )
    })

    it(
        "the store's answer above the form is read, not the standing line",
        async () => {
            const { res, ms } = await timed('NEWBBWELCOME15', SAVED)

            expect(res.success).toBe(false)
            expect(res.errorMsg).toBe(SAID)
            expect(res.errorIsNew).toBe(true)
            expect(ms).toBeLessThan(4000)
        },
        SLOW,
    )

    it(
        'with no answer, the standing line is still what is quoted, as not ours',
        async () => {
            document.getElementById('ap').replaceWith(
                Object.assign(document.createElement('button'), {
                    id: 'ap',
                    type: 'button',
                    textContent: 'Apply',
                }),
            )

            const { res } = await timed('NEWBBWELCOME15', SAVED)

            expect(res.errorMsg).toBe(STANDING)
            expect(res.errorIsNew).toBe(false)
        },
        SLOW,
    )
})

describe('a saved box: a code that works', () => {
    it(
        'a lower total wins, even when a refusal-shaped caveat is printed first',
        async () => {
            document.getElementById('ap').addEventListener('click', () => {
                setTimeout(() => {
                    const p = document.createElement('p')
                    p.textContent =
                        'This code cannot be combined with other offers.'
                    document.querySelector('.promo').appendChild(p)
                }, 100)
                setTimeout(() => {
                    document.getElementById('tot').textContent = '$85.00'
                }, 700)
            })

            const { res } = await timed('TEXT15', SAVED)

            expect(res.success).toBe(true)
            expect(res.newTotal).toBe(85)
        },
        SLOW,
    )

    it(
        'is read as soon as the total moves',
        async () => {
            document.getElementById('ap').addEventListener('click', () =>
                setTimeout(() => {
                    document.getElementById('tot').textContent = '$85.00'
                }, 150),
            )

            const { res, ms } = await timed('TEXT15', SAVED)

            expect(res.success).toBe(true)
            expect(res.newTotal).toBe(85)
            expect(ms).toBeLessThan(4000)
        },
        SLOW,
    )
})

describe('which configs read like a found box', () => {
    it(
        'a saved box that names its own error area keeps reading only that area',
        async () => {
            document.getElementById('ap').addEventListener('click', () =>
                setTimeout(() => {
                    document.getElementById('banner').textContent = REFUSAL
                }, 150),
            )

            const { res, ms } = await timed(
                'BAD15',
                config({ savedBox: true, errorIndicator: '#nowhere' }),
            )

            // Read the plain way: no early answer, and the window quote.
            expect(ms).toBeGreaterThan(9000)
            expect(res.errorMsg).not.toBe(REFUSAL)
        },
        SLOW,
    )
})
