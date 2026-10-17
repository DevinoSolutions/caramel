import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The pick's answer cache across repeat visits to one store. Production saw
// cached=false on all 47 picks (2026-10-14..17): the key hashed the WHOLE
// outline, and on a content-rich store (Amazon) two loads of one page differ
// in dozens of lines. These tests send the outlines such a store really
// produces on a repeat visit.

// MOCK (announced): `chat` is the paid model call; how often it runs is what
// these tests measure.
const { chatMock, envMock } = vi.hoisted(() => ({
    chatMock: vi.fn(async (): Promise<string> => '{}'),
    envMock: {} as Record<string, unknown>,
}))
vi.mock('@/lib/openrouter', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/openrouter')>()
    return { ...actual, chat: chatMock }
})
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    Object.assign(envMock, actual.env)
    return { ...actual, env: envMock }
})
vi.mock('@sentry/nextjs', () => ({
    addBreadcrumb: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
}))

import { pickCouponBox } from '@/lib/couponBoxPick'
import {
    couponBoxStoreKey,
    createCouponBoxAnswerCache,
} from '@/lib/couponBoxPickAnswerCache'

const answer = (a: object) => JSON.stringify({ confidence: 90, why: 'x', ...a })
const freshDomain = () => `shop-${randomUUID().slice(0, 8)}.example`

/** A cart page as two visits see it: the same controls, but a personalised
 * carousel of a different length sits above the promo box, so every index
 * after it moves. `carousel` is the number of recommendation links. */
function cartPage(carousel: number, extra: string[] = []): string {
    const links = Array.from(
        { length: carousel },
        (_, i) => `    - [${3 + i}] link`,
    )
    const at = 3 + carousel
    return [
        '- main:',
        '  - [0] link "Cart"',
        '  - list:',
        ...links,
        ...extra,
        '  - form:',
        `    - [${at}] textbox "Promo code"`,
        `    - [${at + 1}] button "Apply"`,
        `  - [${at + 2}] link "Sign in"`,
    ].join('\n')
}

/** A page with no coupon box at all, behind a carousel of varying length. */
function productPage(carousel: number): string {
    const links = Array.from(
        { length: carousel },
        (_, i) => `    - [${2 + i}] link`,
    )
    return [
        '- main:',
        '  - [0] link "Cart"',
        '  - heading "Reviews"',
        '  - list:',
        ...links,
        `  - [${2 + carousel}] button "Add to cart"`,
    ].join('\n')
}

/** A one-box page whose box label is `n` characters long, so each n is a
 * different page. */
const page = (n: number) =>
    [`- [0] link "Cart"`, `- [1] textbox "Promo ${'x'.repeat(n)}"`].join('\n')

/** A bare textbox at [7] between two given lines. */
const withNeighbours = (before: string, after: string) =>
    [`- ${before}`, '- [7] textbox', `- ${after}`].join('\n')

beforeEach(() => {
    envMock.COUPON_BOX_LLM_ENABLED = true
    envMock.COUPON_BOX_PICK_MODEL = 'test/box-model'
    chatMock.mockReset()
})

describe('repeat visit to one store', () => {
    it('a no-box page that differs only in a carousel is a cache hit', async () => {
        chatMock.mockImplementation(async () => answer({}))
        const domain = freshDomain()
        const first = await pickCouponBox({
            domain,
            outline: productPage(4),
        })
        const second = await pickCouponBox({
            domain,
            outline: productPage(9),
        })
        expect(first).toMatchObject({ outcome: 'no_box', cached: false })
        expect(second).toMatchObject({ outcome: 'no_box', cached: true })
        expect(chatMock).toHaveBeenCalledTimes(1)
    })

    it('a no-box answer does not cover a page that gained a promo control', async () => {
        chatMock.mockImplementation(async () => answer({}))
        const domain = freshDomain()
        await pickCouponBox({ domain, outline: productPage(4) })
        chatMock.mockImplementation(async () => answer({ input: 4, button: 5 }))
        const withBox = await pickCouponBox({ domain, outline: cartPage(1) })
        expect(withBox).toMatchObject({ outcome: 'box', cached: false })
        expect(chatMock).toHaveBeenCalledTimes(2)
    })

    it('a no-box answer does not cover a page that gained a text field, whatever its words', async () => {
        chatMock.mockImplementation(async () => answer({}))
        const domain = freshDomain()
        await pickCouponBox({
            domain,
            outline: ['- [0] link "Cart"', '- [1] button "Checkout"'].join(
                '\n',
            ),
        })
        chatMock.mockImplementation(async () => answer({ input: 1, button: 2 }))
        // The store labelled its box with no coupon word at all.
        const gained = await pickCouponBox({
            domain,
            outline: [
                '- [0] link "Cart"',
                '- [1] textbox',
                '- [2] button "Go"',
            ].join('\n'),
        })
        expect(gained).toMatchObject({
            outcome: 'box',
            input: 1,
            cached: false,
        })
        expect(chatMock).toHaveBeenCalledTimes(2)
    })

    it('a no-box answer does not cover a page that gained an apply control', async () => {
        chatMock.mockImplementation(async () => answer({}))
        const domain = freshDomain()
        await pickCouponBox({
            domain,
            outline: ['- [0] link "Cart"', '- [1] button "Checkout"'].join(
                '\n',
            ),
        })
        await pickCouponBox({
            domain,
            outline: [
                '- [0] link "Cart"',
                '- [1] button "Checkout"',
                '- [2] button "Anwenden"',
            ].join('\n'),
        })
        expect(chatMock).toHaveBeenCalledTimes(2)
    })

    it('a box answer is reused only while its lines sit at the same indexes', async () => {
        chatMock.mockImplementation(async () => answer({ input: 7, button: 8 }))
        const domain = freshDomain()
        const first = await pickCouponBox({ domain, outline: cartPage(4) })
        expect(first).toMatchObject({ outcome: 'box', input: 7, cached: false })

        // Same page again: hit.
        const same = await pickCouponBox({ domain, outline: cartPage(4) })
        expect(same).toMatchObject({ outcome: 'box', input: 7, cached: true })
        expect(chatMock).toHaveBeenCalledTimes(1)

        // The carousel grew: [7] is now a carousel link, so the cached index
        // would point at the wrong control. Must ask the model again.
        chatMock.mockImplementation(async () =>
            answer({ input: 10, button: 11 }),
        )
        const moved = await pickCouponBox({ domain, outline: cartPage(7) })
        expect(moved).toMatchObject({
            outcome: 'box',
            input: 10,
            cached: false,
        })
        expect(chatMock).toHaveBeenCalledTimes(2)
    })

    it('a new coupon-flavoured control on the page is a miss', async () => {
        chatMock.mockImplementation(async () => answer({ input: 7, button: 8 }))
        const domain = freshDomain()
        await pickCouponBox({ domain, outline: cartPage(4) })
        const extra = ['  - [99] button "Gift card code"']
        await pickCouponBox({ domain, outline: cartPage(4, extra) })
        expect(chatMock).toHaveBeenCalledTimes(2)
    })

    it('the store is the same with or without www.', async () => {
        chatMock.mockImplementation(async () => answer({ input: 7, button: 8 }))
        const bare = freshDomain()
        await pickCouponBox({ domain: bare, outline: cartPage(4) })
        const www = await pickCouponBox({
            domain: `www.${bare}`,
            outline: cartPage(4),
        })
        expect(www).toMatchObject({ cached: true })
        expect(chatMock).toHaveBeenCalledTimes(1)
    })

    it("another store never reads this store's answer", async () => {
        chatMock.mockImplementation(async () => answer({ input: 7, button: 8 }))
        await pickCouponBox({ domain: freshDomain(), outline: cartPage(4) })
        await pickCouponBox({ domain: freshDomain(), outline: cartPage(4) })
        expect(chatMock).toHaveBeenCalledTimes(2)
    })
})

describe('createCouponBoxAnswerCache', () => {
    it('normalises the store key', () => {
        expect(couponBoxStoreKey(' WWW.Amazon.de ')).toBe('amazon.de')
        expect(couponBoxStoreKey('amazon.com')).toBe('amazon.com')
    })

    it('the fingerprint sees the coupon and apply vocabulary in every store language, and text fields', () => {
        const base = '- [0] link "Cart"'
        const withLine = (line: string) => [base, `- [1] ${line}`].join('\n')
        // Every one of these changes what the model may answer: a miss.
        const flavoured = [
            'link "Gift card"',
            'button "Have a code?"',
            'button "Apply"',
            'button "Redeem"',
            'link "Promo"',
            'link "Discount"',
            'link "Coupon"',
            'link "Voucher"',
            'link "Cupón"',
            'link "Cupom"',
            'link "Codice"',
            'link "Kod"',
            'link "Bon"',
            'link "Rabatt"',
            'link "Descuento"',
            'link "Desconto"',
            'link "Sconto"',
            'link "Korting"',
            'link "Remise"',
            'link "Réduction"',
            'link "Zniżka"',
            'button "Gutschein einlösen"',
            'button "Anwenden"',
            'button "Aplicar"',
            'button "Appliquer"',
            'button "Applica"',
            'button "Toepassen"',
            'button "Canjear"',
            'button "Resgatar"',
            'button "Saisir"',
            'button "Inserisci"',
            'button "Invoeren"',
            'button "Eingeben"',
            'button "Enter"',
            'textbox',
            'searchbox "Search"',
            'combobox',
        ]
        // Allowlist-stripped controls with no such word: the same page.
        const plain = [
            'link',
            'link "Shopping cart"',
            'button "Add to cart"',
            'link "Sign in"',
        ]
        const cache = createCouponBoxAnswerCache<string>({
            ttlMs: 60_000,
            maxStores: 10,
        })
        cache.set('a.example', base, [], 'no_box')
        for (const line of flavoured)
            expect(cache.get('a.example', withLine(line)), line).toBeNull()
        for (const line of plain)
            expect(cache.get('a.example', withLine(line)), line).toBe('no_box')
    })

    it('keeps at most four answers per store, newest first', () => {
        const cache = createCouponBoxAnswerCache<string>({
            ttlMs: 60_000,
            maxStores: 10,
        })
        for (let n = 1; n <= 6; n++)
            cache.set('a.example', page(n), [1], `v${n}`)
        expect(cache.get('a.example', page(6))).toBe('v6')
        expect(cache.get('a.example', page(3))).toBe('v3')
        expect(cache.get('a.example', page(1))).toBeNull()
    })

    it('a bare picked line is told apart by the lines around it', () => {
        const cache = createCouponBoxAnswerCache<string>({
            ttlMs: 60_000,
            maxStores: 10,
        })
        cache.set(
            'a.example',
            withNeighbours('heading "Order"', '[8] button "Go"'),
            [7],
            'box',
        )
        expect(
            cache.get(
                'a.example',
                withNeighbours('heading "Order"', '[8] button "Go"'),
            ),
        ).toBe('box')
        // The same bare textbox at [7], but a different field next to it.
        expect(
            cache.get(
                'a.example',
                withNeighbours('heading "Newsletter"', '[8] button "Go"'),
            ),
        ).toBeNull()
        expect(
            cache.get(
                'a.example',
                withNeighbours('heading "Order"', '[8] button "Join"'),
            ),
        ).toBeNull()
    })

    it('each answer expires on its own clock, not on the newest answer of its store', () => {
        vi.useFakeTimers()
        try {
            const cache = createCouponBoxAnswerCache<string>({
                ttlMs: 1000,
                maxStores: 10,
            })
            const a = '- [0] link "Cart"'
            const b = ['- [0] link "Cart"', '- [1] textbox "Promo code"'].join(
                '\n',
            )
            cache.set('a.example', a, [], 'A')
            vi.advanceTimersByTime(900)
            cache.set('a.example', b, [1], 'B')
            vi.advanceTimersByTime(900)
            // 1800ms: A is 1800 old (expired), B is 900 old (live).
            expect(cache.get('a.example', a)).toBeNull()
            expect(cache.get('a.example', b)).toBe('B')
        } finally {
            vi.useRealTimers()
        }
    })

    it('expires with the ttl', () => {
        vi.useFakeTimers()
        try {
            const cache = createCouponBoxAnswerCache<string>({
                ttlMs: 1000,
                maxStores: 10,
            })
            const outline = '- [0] link "Cart"'
            cache.set('a.example', outline, [], 'v')
            expect(cache.get('a.example', outline)).toBe('v')
            vi.advanceTimersByTime(1001)
            expect(cache.get('a.example', outline)).toBeNull()
        } finally {
            vi.useRealTimers()
        }
    })
})
