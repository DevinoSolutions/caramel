import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /api/extension/coupon-box-pick + src/lib/couponBoxPick.ts: the feature
// switch, the server-side re-scrub, index validation, the answer cache, the
// model-call budget, and that a model failure is a "no pick", never a 500.

// MOCK (announced): `chat` is the paid model call — whether and how often it
// runs, and what it is sent, is what these tests measure.
const { chatMock, envMock, captureExceptionMock, captureMessageMock } =
    vi.hoisted(() => ({
        chatMock: vi.fn(async (): Promise<string> => '{}'),
        envMock: {} as Record<string, unknown>,
        captureExceptionMock: vi.fn(),
        captureMessageMock: vi.fn(),
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
    captureException: captureExceptionMock,
    captureMessage: captureMessageMock,
}))
// MOCK (announced): abuseSignal's throttling/PostHog fan-out is pinned in
// abuse-signal.test.ts; here a per-client trip only needs to be harmless.
vi.mock('@/lib/abuseSignal', () => ({
    reportRateLimitRejection: vi.fn(async () => false),
}))
// MOCK (announced): the outcome event (coupon-box-pick-outcome.test.ts pins
// it) must not leave the process, and after() needs a Next request scope vitest
// does not have, so it runs its task inline.
vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: vi.fn(async () => true),
}))
vi.mock('next/server', async importOriginal => ({
    ...(await importOriginal<typeof import('next/server')>()),
    after: (task: () => unknown) => {
        void task()
    },
}))
// The route's generic per-IP limiter is rateLimit.ts's own, pinned elsewhere;
// switched off so these tests measure the model-call budget alone.
vi.mock('@/lib/rateLimit', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/rateLimit')>()
    return { ...actual, checkRateLimit: vi.fn(async () => null) }
})

import { OPTIONS, POST } from '@/app/api/extension/coupon-box-pick/route'
import { GET as featuresGET } from '@/app/api/extension/features/route'
import {
    CouponBoxOutlineTooLargeError,
    MAX_OUTLINE_BYTES,
    pickCouponBox,
    scrubOutline,
} from '@/lib/couponBoxPick'
import {
    COUPON_BOX_PICK_BUDGET,
    resetCouponBoxPickBudgetForTests,
} from '@/lib/couponBoxPickBudget'
import { MIN_PAID_PATH_DEADLINE_SECONDS } from '@/lib/proxy-fallback-headers'
import { couponBoxCases } from '../../evals/fixtures/coupon-box-cases'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

const OUTLINE = [
    '- main:',
    '  - [3] link "Cart"',
    '  - form:',
    '    - [7] textbox "Promo code"',
    '    - [8] button "Apply"',
    '  - [12] button "Have a promo code?"',
].join('\n')

const answer = (a: object) => JSON.stringify({ confidence: 90, why: 'x', ...a })

/** A fresh domain per call is a guaranteed cache miss. */
const freshDomain = () => `shop-${randomUUID().slice(0, 8)}.example`

function post(
    body: unknown,
    {
        origin = EXT_ORIGIN,
        ip = '203.0.113.5',
    }: { origin?: string | null; ip?: string } = {},
) {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'cf-connecting-ip': ip,
    }
    if (origin) headers.origin = origin
    return POST(
        new NextRequest('http://localhost/api/extension/coupon-box-pick', {
            method: 'POST',
            headers,
            body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
    )
}

async function readFeatures() {
    const res = await featuresGET(
        new NextRequest('http://localhost/api/extension/features'),
    )
    return res.json()
}

beforeEach(() => {
    envMock.COUPON_BOX_LLM_ENABLED = true
    envMock.COUPON_BOX_PICK_MODEL = 'test/box-model'
    chatMock.mockReset()
    chatMock.mockImplementation(async () => answer({ input: 7, button: 8 }))
    captureExceptionMock.mockClear()
    captureMessageMock.mockClear()
    resetCouponBoxPickBudgetForTests()
})

describe('feature switch', () => {
    it('flag off: answers no_pick/disabled and never calls the model', async () => {
        envMock.COUPON_BOX_LLM_ENABLED = false
        const res = await post({ domain: freshDomain(), outline: OUTLINE })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            outcome: 'no_pick',
            reason: 'disabled',
        })
        expect(chatMock).not.toHaveBeenCalled()
    })

    it('flag on but no model configured: still disabled, no model call', async () => {
        envMock.COUPON_BOX_PICK_MODEL = undefined
        const res = await post({ domain: freshDomain(), outline: OUTLINE })
        expect(await res.json()).toEqual({
            outcome: 'no_pick',
            reason: 'disabled',
        })
        expect(chatMock).not.toHaveBeenCalled()
    })

    it('features route reports couponBoxLlm with the same condition', async () => {
        expect((await readFeatures()).couponBoxLlm).toBe(true)
        envMock.COUPON_BOX_PICK_MODEL = undefined
        expect((await readFeatures()).couponBoxLlm).toBe(false)
        envMock.COUPON_BOX_PICK_MODEL = 'test/box-model'
        envMock.COUPON_BOX_LLM_ENABLED = false
        expect((await readFeatures()).couponBoxLlm).toBe(false)
    })
})

describe('request gates', () => {
    it('refuses a request without an extension Origin (403), no model call', async () => {
        const res = await post(
            { domain: freshDomain(), outline: OUTLINE },
            { origin: null },
        )
        expect(res.status).toBe(403)
        expect(chatMock).not.toHaveBeenCalled()
    })

    it('rejects a malformed body with 400', async () => {
        expect((await post('not json')).status).toBe(400)
        expect((await post({ domain: 'x', outline: OUTLINE })).status).toBe(400)
        expect((await post({ domain: freshDomain() })).status).toBe(400)
        expect(chatMock).not.toHaveBeenCalled()
    })

    it('rejects an outline over the cap with 413, and the lib refuses it too', async () => {
        const outline = `- [1] textbox "Promo"\n${'- heading "x"\n'.repeat(3500)}`
        expect(Buffer.byteLength(outline)).toBeGreaterThan(MAX_OUTLINE_BYTES)
        expect((await post({ domain: freshDomain(), outline })).status).toBe(
            413,
        )
        await expect(
            pickCouponBox({ domain: freshDomain(), outline }),
        ).rejects.toBeInstanceOf(CouponBoxOutlineTooLargeError)
        expect(chatMock).not.toHaveBeenCalled()
    })

    it('answers a preflight with 204', async () => {
        const res = await OPTIONS(
            new NextRequest('http://localhost/api/extension/coupon-box-pick', {
                method: 'OPTIONS',
            }),
        )
        expect(res.status).toBe(204)
    })
})

describe('the pick', () => {
    it('returns the picked indexes', async () => {
        const res = await post({ domain: freshDomain(), outline: OUTLINE })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            outcome: 'box',
            input: 7,
            button: 8,
            toggle: null,
            confidence: 90,
            why: 'x',
            cached: false,
        })
    })

    it('sends the configured model, the outline under a Store line, and the exact-model header', async () => {
        const domain = freshDomain()
        await pickCouponBox({ domain, outline: OUTLINE })
        expect(chatMock).toHaveBeenCalledTimes(1)
        const [messages, opts] = chatMock.mock.calls[0] as unknown as [
            { role: string; content: string }[],
            Record<string, unknown>,
        ]
        expect(messages[0]!.role).toBe('system')
        expect(messages[1]).toEqual({
            role: 'user',
            content: `Store: ${domain}\n\n${OUTLINE}`,
        })
        expect(opts).toMatchObject({
            model: 'test/box-model',
            temperature: 0,
            responseFormat: 'json_object',
            headers: { 'X-ORF-Strict': '1' },
        })
    })

    describe('the paid fallback (Aladdin approved 2026-10-23)', () => {
        const KEY = 'sk-or-v1-' + 'test000000000000000000000000'
        const keep = {
            url: envMock.OPENROUTER_API_URL,
            key: envMock.OPENROUTER_FALLBACK_API_KEY,
            model: envMock.OPENROUTER_FALLBACK_MODEL,
            after: envMock.OPENROUTER_FALLBACK_AFTER_SECONDS,
        }
        const restore = () => {
            envMock.OPENROUTER_API_URL = keep.url
            envMock.OPENROUTER_FALLBACK_API_KEY = keep.key
            envMock.OPENROUTER_FALLBACK_MODEL = keep.model
            envMock.OPENROUTER_FALLBACK_AFTER_SECONDS = keep.after
        }
        const sentHeaders = () =>
            (
                chatMock.mock.calls[0] as unknown as [
                    unknown,
                    { headers: Record<string, string> },
                ]
            )[1].headers

        it('with no key set, sends only the exact-model header', async () => {
            envMock.OPENROUTER_API_URL = 'https://proxyai.devino.ca/v1'
            envMock.OPENROUTER_FALLBACK_API_KEY = undefined
            try {
                await pickCouponBox({ domain: freshDomain(), outline: OUTLINE })
                expect(sentHeaders()).toEqual({ 'X-ORF-Strict': '1' })
            } finally {
                restore()
            }
        })

        it('with a key and the Devino proxy, sends the key, model and wait beside the exact-model header', async () => {
            envMock.OPENROUTER_API_URL = 'https://proxyai.devino.ca/v1'
            envMock.OPENROUTER_FALLBACK_API_KEY = KEY
            envMock.OPENROUTER_FALLBACK_MODEL = 'deepseek/deepseek-v4.1-flash'
            envMock.OPENROUTER_FALLBACK_AFTER_SECONDS = '6'
            try {
                await pickCouponBox({ domain: freshDomain(), outline: OUTLINE })
                expect(sentHeaders()).toEqual({
                    'X-ORF-Strict': '1',
                    'X-ORF-Fallback-Key': KEY,
                    'X-ORF-Fallback-Model': 'deepseek/deepseek-v4.1-flash',
                    'X-ORF-Fallback-After': '6',
                })
            } finally {
                restore()
            }
        })

        it('with a key but a base URL that is not the Devino proxy, sends no key', async () => {
            envMock.OPENROUTER_API_URL = 'https://openrouter.ai/api/v1'
            envMock.OPENROUTER_FALLBACK_API_KEY = KEY
            try {
                await pickCouponBox({ domain: freshDomain(), outline: OUTLINE })
                expect(sentHeaders()).toEqual({ 'X-ORF-Strict': '1' })
            } finally {
                restore()
            }
        })

        it('gives the call at least the paid path minimum, so a paid answer can still arrive', async () => {
            await pickCouponBox({ domain: freshDomain(), outline: OUTLINE })
            const [, opts] = chatMock.mock.calls[0] as unknown as [
                unknown,
                { timeoutMs: number },
            ]
            expect(opts.timeoutMs).toBeGreaterThanOrEqual(
                MIN_PAID_PATH_DEADLINE_SECONDS * 1000,
            )
        })
    })

    it('re-scrubs digits and emails before sending, keeping the [n] indexes', async () => {
        const outline = [
            '- [10004] button "Order Summary 12 €"',
            '- [7] textbox "Promo code"',
            '- text "Signed in as jane.doe+x@mail.example.com since 2024"',
        ].join('\n')
        expect(scrubOutline(outline)).toBe(
            [
                '- [10004] button "Order Summary ## €"',
                '- [7] textbox "Promo code"',
                '- text "Signed in as [email] since ####"',
            ].join('\n'),
        )
        await pickCouponBox({ domain: freshDomain(), outline })
        const [messages] = chatMock.mock.calls[0] as unknown as [
            { content: string }[],
        ]
        const sent = messages[1]!.content
        expect(sent).not.toMatch(/jane|2024|12 €/)
        expect(sent).toContain('[10004] button "Order Summary ## €"')
    })

    it('keeps every index across CR, CRLF and Unicode line breaks', () => {
        expect(
            scrubOutline(
                '- [7] textbox "Promo"\r\n- [8] button "Apply"\r- [9] link "Pr omo 5"',
            ),
        ).toBe(
            '- [7] textbox "Promo"\n- [8] button "Apply"\n- [9] link "Pr\nomo #"',
        )
    })

    it('scrubs a number that only looks like an index', () => {
        expect(
            scrubOutline(
                ['- [4155551234] textbox "x"', '- [12] "call 555"'].join('\n'),
            ),
        ).toBe(['- [##########] textbox "x"', '- [##] "call ###"'].join('\n'))
    })

    it('scrubs digits in any script, not only 0-9', () => {
        expect(scrubOutline('- [3] button "to ۰۹۱۲ ٠١٢ ０３１ ①𝟏Ⅷ"')).toBe(
            '- [3] button "to #### ### ### ###"',
        )
    })

    it('redacts a token that mixes letters and digits before masking digits (T-9959)', async () => {
        const scrubbed = scrubOutline(
            '- [12] button "Remove SAVE10"\n- [13] button "Apply"',
        )
        expect(scrubbed).toBe(
            '- [12] button "Remove [code]"\n- [13] button "Apply"',
        )
        expect(scrubbed).not.toContain('SAVE10')
        expect(scrubbed).not.toContain('SAVE#')

        await pickCouponBox({
            domain: freshDomain(),
            outline: '- [12] button "Remove SAVE10"\n- [7] textbox "Promo"',
        })
        const [messages] = chatMock.mock.calls[0] as unknown as [
            { content: string }[],
        ]
        expect(messages[1]!.content).not.toMatch(/SAVE10|SAVE#/)
        expect(messages[1]!.content).toContain('[12] button "Remove [code]"')
    })

    it('masks an email whose local part carries digits as an email, not as a code', () => {
        expect(scrubOutline('- text "jane2@mail.example.com"')).toBe(
            '- text "[email]"',
        )
    })

    it('drops an index that is not in the outline (a hallucination)', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: 99, button: 8, toggle: 12 }),
        )
        const result = await pickCouponBox({
            domain: freshDomain(),
            outline: OUTLINE,
        })
        expect(result).toMatchObject({
            outcome: 'box',
            input: null,
            button: 8,
            toggle: 12,
        })
    })

    it('no input and no toggle is a "no box" answer', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: null, button: null, toggle: null }),
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: OUTLINE }),
        ).toEqual({
            outcome: 'no_box',
            confidence: 90,
            why: 'x',
            cached: false,
        })

        // A hallucinated input with no toggle is "no box" too.
        chatMock.mockImplementation(async () =>
            answer({ input: 404, button: 8, toggle: null }),
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: OUTLINE }),
        ).toMatchObject({ outcome: 'no_box' })
    })

    // The extension types into the input and CLICKS the button and toggle,
    // so an index of the wrong kind of element, or of a control that leaves
    // the cart or spends money, is refused.
    const GUARDED = [
        '- main:',
        '  - [2] textbox "Promo code"',
        '  - [3] button "Apply"',
        '  - [4] button "Checkout"',
        '  - [5] link "Remove item"',
        '  - [6] button "Place order"',
        '  - [7] button "Sign in"',
        '  - [8] link "Continue shopping"',
        '  - [9] checkbox "Gift wrap"',
        '  - [10] button "Have a promo code?"',
        '  - [11] button "Pay with PayPal"',
    ].join('\n')

    // A refused apply button refuses the whole answer. Sent as button null,
    // the extension would read "this box applies on Enter", and Enter in the
    // box can submit the checkout or order button the model named.
    it.each([4, 5, 6, 7, 8, 11, 2, 99])(
        'refuses the answer when the apply button is control [%i]',
        async n => {
            chatMock.mockImplementation(async () =>
                answer({ input: 2, button: n, toggle: null }),
            )
            expect(
                await pickCouponBox({
                    domain: freshDomain(),
                    outline: GUARDED,
                }),
            ).toEqual({
                outcome: 'no_pick',
                reason: 'refused_button',
                cached: false,
            })
        },
    )

    it('caches a refused button like any answer', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: 2, button: 4, toggle: null }),
        )
        const domain = freshDomain()
        await pickCouponBox({ domain, outline: GUARDED })
        expect(await pickCouponBox({ domain, outline: GUARDED })).toEqual({
            outcome: 'no_pick',
            reason: 'refused_button',
            cached: true,
        })
        expect(chatMock).toHaveBeenCalledTimes(1)
    })

    it('keeps a box whose answer names no button (it applies on Enter)', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: 2, button: null, toggle: null }),
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: GUARDED }),
        ).toMatchObject({ outcome: 'box', input: 2, button: null })
    })

    it.each([4, 5, 6, 7, 11])(
        'never returns control [%i] as the toggle',
        async n => {
            chatMock.mockImplementation(async () =>
                answer({ input: null, button: null, toggle: n }),
            )
            expect(
                await pickCouponBox({
                    domain: freshDomain(),
                    outline: GUARDED,
                }),
            ).toMatchObject({ outcome: 'no_box' })
        },
    )

    it('refuses an input that is not a text field', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: 9, button: 3, toggle: null }),
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: GUARDED }),
        ).toMatchObject({ outcome: 'no_box' })
    })

    it('keeps a real apply button and a real toggle', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: 2, button: 3, toggle: 10 }),
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: GUARDED }),
        ).toMatchObject({ outcome: 'box', input: 2, button: 3, toggle: 10 })
    })

    // The page footer (the last contentinfo nested in nothing) holds links to
    // other pages; restaurant.com's footer has "Have A Code?" beside Gift
    // Cards. A footer inside the cart, or a dialog opened from the page
    // footer, is still part of the cart.
    const FOOTERED = [
        '- main:',
        '  - form:',
        '    - [2] textbox "Promo code"',
        '    - [3] button "Apply"',
        '  - contentinfo:',
        '    - [4] button "Have a promo code?"',
        '- contentinfo:',
        '  - list:',
        '    - [5] link "Have A Code?"',
        '    - [6] button "Apply"',
        '  - dialog:',
        '    - [7] button "Add discount code"',
        '- [8] link "Have a promo code?"',
    ].join('\n')

    it('never returns a page-footer control as the toggle', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: null, button: null, toggle: 5 }),
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: FOOTERED }),
        ).toMatchObject({ outcome: 'no_box' })
    })

    it('never refuses an apply button for where it sits', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: 2, button: 6, toggle: null }),
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: FOOTERED }),
        ).toMatchObject({ outcome: 'box', input: 2, button: 6 })
    })

    it.each([4, 7, 8])(
        'keeps toggle [%i]: a cart footer, a dialog, or a line after the page footer',
        async n => {
            chatMock.mockImplementation(async () =>
                answer({ input: null, button: null, toggle: n }),
            )
            expect(
                await pickCouponBox({
                    domain: freshDomain(),
                    outline: FOOTERED,
                }),
            ).toMatchObject({ outcome: 'box', input: null, toggle: n })
        },
    )

    // A cart built of plain divs, with no <main>, whose order summary is a
    // <footer>: it prints as a top-level contentinfo, but not the last one.
    const DIV_CART = [
        '- banner:',
        '  - [0] link "Cart"',
        '- [1] button "Remove"',
        '- contentinfo:',
        '  - heading "Order summary"',
        '  - [2] button "Have a promo code?" [collapsed]',
        '  - [3] textbox "Promo code"',
        '  - [4] button "Apply"',
        '  - [5] button "Checkout"',
        '- contentinfo:',
        '  - list:',
        '    - [6] link "Help"',
        '    - [7] link "Have A Code?"',
    ].join('\n')

    it('keeps the toggle and the box in a cart summary drawn as a footer', async () => {
        chatMock.mockImplementation(async () =>
            answer({ input: 3, button: 4, toggle: 2 }),
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: DIV_CART }),
        ).toMatchObject({ outcome: 'box', input: 3, button: 4, toggle: 2 })

        chatMock.mockImplementation(async () =>
            answer({ input: null, button: null, toggle: 7 }),
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: DIV_CART }),
        ).toMatchObject({ outcome: 'no_box' })
    })

    const pickOn = async (outline: string, a: object) => {
        chatMock.mockImplementation(async () => answer(a))
        return pickCouponBox({ domain: freshDomain(), outline })
    }

    // A footer that holds the cart's checkout or total is the cart's own
    // summary, wherever it sits, and an outline the extension may have cut at
    // its size cap may have lost the real page footer: neither is read as the
    // page footer.
    const STICKY = [
        '- main:',
        '  - [1] link "Classic"',
        '- contentinfo:',
        '  - list:',
        '    - [2] link "Help"',
        '    - [3] link "Have A Code?"',
        '- contentinfo:',
        '  - heading "Order total"',
        '  - [4] button "Have a promo code?" [collapsed]',
        '  - [5] button "Checkout"',
    ].join('\n')

    it('keeps a toggle in a cart summary drawn after the site footer', async () => {
        expect(await pickOn(STICKY, { toggle: 4 })).toMatchObject({
            outcome: 'box',
            toggle: 4,
        })
        expect(await pickOn(STICKY, { toggle: 3 })).toMatchObject({
            outcome: 'no_box',
        })
    })

    it('reads no page footer in an outline that may have been cut at the cap', async () => {
        const footer = ['- contentinfo:', '  - [5] link "Have a promo code?"']
        const padded = (bytes: number) => {
            const pad = '  - heading "Your cart"'
            const lines = ['- main:']
            while ((lines.length + 3) * (pad.length + 1) < bytes)
                lines.push(pad)
            return [...lines, ...footer].join('\n')
        }
        const cut = padded(MAX_OUTLINE_BYTES - 100)
        expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(MAX_OUTLINE_BYTES)
        expect(Buffer.byteLength(cut)).toBeGreaterThan(MAX_OUTLINE_BYTES - 1024)
        expect(await pickOn(cut, { toggle: 5 })).toMatchObject({
            outcome: 'box',
            toggle: 5,
        })
        expect(
            await pickOn(padded(MAX_OUTLINE_BYTES - 4096), { toggle: 5 }),
        ).toMatchObject({ outcome: 'no_box' })
    })

    // Rewards are the shopper's own money: a control that redeems points or
    // rewards is never clicked on the model's word. A field that takes a
    // rewards code is still a code field. The outline as an extension with the
    // 2026-10-17 word list sends it ("points" kept).
    const REWARDS = [
        '- main:',
        '  - heading "You have #,### points"',
        '  - [0] button "Redeem ### points for a $# discount code"',
        '  - [1] button "Apply Rewards"',
        '  - [2] link "Loyalty"',
        '  - [3] textbox "Promo or rewards code"',
        '  - [4] button "Apply"',
    ].join('\n')

    it.each([0, 1, 2])(
        'never returns rewards control [%i] as the toggle',
        async n => {
            expect(await pickOn(REWARDS, { toggle: n })).toMatchObject({
                outcome: 'no_box',
            })
        },
    )

    it('keeps a promo-or-rewards code field and its Apply, and refuses its rewards button', async () => {
        expect(await pickOn(REWARDS, { input: 3, button: 4 })).toMatchObject({
            outcome: 'box',
            input: 3,
            button: 4,
        })
        expect(await pickOn(REWARDS, { input: 3, button: 1 })).toMatchObject({
            outcome: 'no_pick',
            reason: 'refused_button',
        })
    })

    it('never returns a points-for-a-code redemption as the toggle, with or without "points"', async () => {
        for (const name of [
            'Redeem ### points for a $# discount code',
            'Redeem ### for a $# discount code',
        ])
            expect(
                await pickOn(
                    `- main:\n  - heading "Order summary"\n  - [1] button "${name}"`,
                    { toggle: 1 },
                ),
            ).toMatchObject({ outcome: 'no_box' })
    })

    // "Redeem" is how some stores name a code box's apply button: it is kept
    // beside a field that names a code, and refused anywhere else.
    const REDEEM_BOX = (field: string, button = 'Redeem') =>
        [
            '- main:',
            '  - form:',
            `    - [1] textbox "${field}"`,
            `    - [2] button "${button}"`,
            '  - [3] button "Checkout"',
        ].join('\n')

    it.each([
        'Promo code',
        'Discount code',
        'Voucher',
        'Gift card or discount code',
        'rabattkod',
        // "Bon de réduction" as the outline prints it: "de" is not on the
        // extension's word list.
        'Bon réduction',
    ])(
        'keeps "Redeem" beside a "%s" field as the apply button',
        async field => {
            expect(
                await pickOn(REDEEM_BOX(field), { input: 1, button: 2 }),
            ).toMatchObject({ outcome: 'box', input: 1, button: 2 })
        },
    )

    it('keeps an apply button whose own name is a rewards code', async () => {
        expect(
            await pickOn(REDEEM_BOX('Promo code', 'Add rewards code'), {
                input: 1,
                button: 2,
            }),
        ).toMatchObject({ outcome: 'box', input: 1, button: 2 })
    })

    // A code word on the control wins, as in the extension's spendsPoints:
    // "rewards code" names a code to type, not points to spend.
    it('keeps "Apply rewards code" as the apply button', async () => {
        expect(
            await pickOn(REDEEM_BOX('Promo code', 'Apply rewards code'), {
                input: 1,
                button: 2,
            }),
        ).toMatchObject({ outcome: 'box', input: 1, button: 2 })
    })

    const IN_SUMMARY = (line: string) =>
        [
            '- main:',
            '  - region "Order summary":',
            '    - heading "Order summary"',
            `    ${line}`,
            '    - [9] button "Checkout"',
        ].join('\n')

    it('keeps "Have a promo or rewards code?" as the toggle', async () => {
        expect(
            await pickOn(
                IN_SUMMARY(
                    '- [5] button "Have a promo or rewards code?" [collapsed]',
                ),
                { toggle: 5 },
            ),
        ).toMatchObject({ outcome: 'box', toggle: 5 })
    })

    it.each(['Redeem ### points for a $# code', 'Use your points'])(
        'still refuses "%s" as the toggle',
        async name => {
            expect(
                await pickOn(IN_SUMMARY(`- [5] button "${name}" [collapsed]`), {
                    toggle: 5,
                }),
            ).toMatchObject({ outcome: 'no_box' })
        },
    )

    it('still refuses "Redeem ### points for a $# code" as the apply button', async () => {
        expect(
            await pickOn(
                REDEEM_BOX('Promo code', 'Redeem ### points for a $# code'),
                { input: 1, button: 2 },
            ),
        ).toMatchObject({ outcome: 'no_pick', reason: 'refused_button' })
    })

    it('refuses an Apply that spends the points its section names', async () => {
        expect(
            await pickOn(
                [
                    '- main:',
                    '  - region "Order summary":',
                    '    - heading "Use your ### points"',
                    '    - [5] textbox',
                    '    - [6] button "Apply"',
                    '    - [9] button "Checkout"',
                ].join('\n'),
                { input: 5, button: 6 },
            ),
        ).toMatchObject({ outcome: 'no_pick', reason: 'refused_button' })
    })

    it('keeps a "Redeem code" button, whatever the field says', async () => {
        expect(
            await pickOn(REDEEM_BOX('Enter here', 'Redeem code'), {
                input: 1,
                button: 2,
            }),
        ).toMatchObject({ outcome: 'box', input: 1, button: 2 })
    })

    it.each(['Gift message', 'Enter here'])(
        'refuses "Redeem" beside a "%s" field, which names no code',
        async field => {
            expect(
                await pickOn(REDEEM_BOX(field), { input: 1, button: 2 }),
            ).toMatchObject({ outcome: 'no_pick', reason: 'refused_button' })
        },
    )

    it('a bare "Redeem" is never the toggle; "Redeem a promo code" is', async () => {
        const toggleOn = (name: string) =>
            pickOn(
                [
                    '- main:',
                    '  - heading "Order summary"',
                    `  - [1] button "${name}" [collapsed]`,
                    '  - [2] button "Checkout"',
                ].join('\n'),
                { toggle: 1 },
            )
        expect(await toggleOn('Redeem')).toMatchObject({ outcome: 'no_box' })
        expect(await toggleOn('Redeem a promo code')).toMatchObject({
            outcome: 'box',
            toggle: 1,
        })
    })

    // A toggle opens a box to type a code into. One that says only "discount"
    // is a code box's fold, unless points, rewards, a membership or a gift
    // card are named on it or around it (coupon-box-discovery.js offersOnly).
    // One that offers deals, or explains one, names no code.
    const SUMMARY = (...lines: string[]) =>
        [
            '- main:',
            '  - heading "Your cart"',
            '  - [0] link "Classic"',
            '  - region "Order summary":',
            '    - heading "Order summary"',
            ...lines.map(l => `    ${l}`),
            '    - [9] button "Checkout"',
        ].join('\n')

    it.each([
        'Have a discount?',
        'Add discount',
        'Apply a discount',
        'Discount',
        'Apply discount',
    ])('a plain "%s" reveal is the toggle', async name => {
        expect(
            await pickOn(SUMMARY(`- [5] button "${name}" [collapsed]`), {
                toggle: 5,
            }),
        ).toMatchObject({ outcome: 'box', toggle: 5 })
    })

    it.each([
        [
            'under a points balance',
            [
                '- heading "You have #,### points"',
                '- [5] button "Apply discount"',
            ],
        ],
        ['naming a member discount', ['- [5] button "Member discount"']],
        ['naming rewards', ['- [5] button "Discounts & rewards"']],
        ['naming a student discount', ['- [5] link "Student discount"']],
        ['naming a military discount', ['- [5] link "Military discount"']],
        ['naming a teacher discount', ['- [5] link "Teacher discount"']],
        [
            'in a Rewards section',
            ['- region "Rewards":', '  - [5] button "Apply discount"'],
        ],
        [
            'beside a gift card field',
            [
                '- [4] textbox "Gift card number"',
                '- [5] button "Apply discount"',
            ],
        ],
    ])('a discount reveal %s is never the toggle', async (_why, lines) => {
        expect(await pickOn(SUMMARY(...lines), { toggle: 5 })).toMatchObject({
            outcome: 'no_box',
        })
    })

    it.each([
        'View offers',
        'Available Offers',
        'View promotions',
        'Promo details',
        'Offer terms',
    ])('"%s" names no code and is never the toggle', async name => {
        expect(
            await pickOn(SUMMARY(`- [5] button "${name}" [collapsed]`), {
                toggle: 5,
            }),
        ).toMatchObject({ outcome: 'no_box' })
    })

    it.each([
        'Promo',
        'Promo-Code',
        'Add Discount Code',
        'rabattkod',
        'Ange kampanjkod',
        'Ajouter un bon de réduction',
        'Codice sconto',
        'Código de descuento',
    ])('"%s" names a code and is the toggle', async name => {
        expect(
            await pickOn(SUMMARY(`- [5] button "${name}" [collapsed]`), {
                toggle: 5,
            }),
        ).toMatchObject({ outcome: 'box', toggle: 5 })
    })

    it('keeps an "Apply discount" apply button beside a code field', async () => {
        expect(
            await pickOn(
                SUMMARY(
                    '- [4] textbox "Promo code"',
                    '- [5] button "Apply discount"',
                ),
                { input: 4, button: 5 },
            ),
        ).toMatchObject({ outcome: 'box', input: 4, button: 5 })
    })

    it('reads the first JSON object out of a reply with prose around it', async () => {
        chatMock.mockImplementation(
            async () => `Sure: ${answer({ input: 7 })}\nHope that helps {}`,
        )
        expect(
            await pickCouponBox({ domain: freshDomain(), outline: OUTLINE }),
        ).toMatchObject({ outcome: 'box', input: 7 })
    })

    // A cosmetic field going wrong never throws away a usable pick: the
    // confidence is clamped, a missing reason is empty, and a malformed index
    // is a non-answer for that field alone.
    it.each([
        [
            'an out-of-range confidence',
            answer({ input: 7, confidence: 150 }),
            { input: 7, confidence: 100 },
        ],
        [
            'a string confidence',
            answer({ input: 7, confidence: '80' }),
            { input: 7, confidence: 80 },
        ],
        [
            'a missing why',
            JSON.stringify({ input: 7, button: 8, confidence: 90 }),
            { input: 7, button: 8, why: '' },
        ],
        [
            'a non-integer button',
            answer({ input: 7, button: 'eight' }),
            { input: 7, button: null },
        ],
    ])(
        'keeps the pick when the reply has %s',
        async (_label, reply, expected) => {
            chatMock.mockImplementation(async () => reply)
            expect(
                await pickCouponBox({
                    domain: freshDomain(),
                    outline: OUTLINE,
                }),
            ).toMatchObject({ outcome: 'box', ...expected })
        },
    )

    it.each([
        ['non-JSON prose', 'I think the promo box is number seven.'],
        ['a JSON array', '[7, 8]'],
    ])(
        'malformed output (%s) is no_pick/unparsable, logged to Sentry, never cached',
        async (_label, reply) => {
            chatMock.mockImplementation(async () => reply)
            const domain = freshDomain()
            const res = await post({ domain, outline: OUTLINE })
            expect(res.status).toBe(200)
            expect(await res.json()).toEqual({
                outcome: 'no_pick',
                reason: 'unparsable',
            })
            expect(captureMessageMock).toHaveBeenCalledWith(
                'coupon-box-pick: unusable model reply',
                expect.objectContaining({ level: 'warning' }),
            )
            // Not cached: the next identical request asks the model again.
            await post({ domain, outline: OUTLINE })
            expect(chatMock).toHaveBeenCalledTimes(2)
        },
    )

    it('a model error is no_pick/model_error (a 200, not a 500), logged to Sentry', async () => {
        chatMock.mockImplementation(async () => {
            throw new Error('upstream 503')
        })
        const res = await post({ domain: freshDomain(), outline: OUTLINE })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            outcome: 'no_pick',
            reason: 'model_error',
        })
        expect(captureExceptionMock).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({
                level: 'error',
                tags: expect.objectContaining({ surface: 'coupon-box-pick' }),
                fingerprint: ['coupon-box-pick', 'model_call', 'error'],
            }),
        )
    })

    // T-7526: the upstream timeout (openrouter.ts aborts the fetch) used to be
    // grouped by minified frames, so every release reopened it as a new issue.
    it('a model timeout is a warning under one stable fingerprint', async () => {
        chatMock.mockImplementation(async () => {
            throw new DOMException('This operation was aborted', 'AbortError')
        })
        const res = await post({ domain: freshDomain(), outline: OUTLINE })
        expect(await res.json()).toEqual({
            outcome: 'no_pick',
            reason: 'model_error',
        })
        expect(captureExceptionMock).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'AbortError' }),
            expect.objectContaining({
                level: 'warning',
                fingerprint: ['coupon-box-pick', 'model_call', 'timeout'],
            }),
        )
    })

    it('a repeated (store, outline) is a cache hit: the model is not called again', async () => {
        const domain = freshDomain()
        const first = await post({ domain, outline: OUTLINE })
        const second = await post({ domain, outline: OUTLINE })
        expect((await first.json()).cached).toBe(false)
        expect(await second.json()).toMatchObject({
            outcome: 'box',
            input: 7,
            cached: true,
        })
        expect(chatMock).toHaveBeenCalledTimes(1)
        // A different store with the same outline is a different answer.
        await post({ domain: freshDomain(), outline: OUTLINE })
        expect(chatMock).toHaveBeenCalledTimes(2)
    })
})

describe('model-call budget', () => {
    it('one client: allows its budget of paid calls, then 429s without calling the model', async () => {
        for (let i = 0; i < COUPON_BOX_PICK_BUDGET.perClient; i++) {
            expect(
                (
                    await post(
                        { domain: freshDomain(), outline: OUTLINE },
                        { ip: '198.51.100.20' },
                    )
                ).status,
            ).toBe(200)
        }
        const refused = await post(
            { domain: freshDomain(), outline: OUTLINE },
            { ip: '198.51.100.20' },
        )
        expect(refused.status).toBe(429)
        expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
        expect(chatMock).toHaveBeenCalledTimes(COUPON_BOX_PICK_BUDGET.perClient)
        // A different client is unaffected.
        expect(
            (
                await post(
                    { domain: freshDomain(), outline: OUTLINE },
                    { ip: '198.51.100.21' },
                )
            ).status,
        ).toBe(200)
    })

    it('cache hits are free: repeating one page never spends budget', async () => {
        const domain = freshDomain()
        for (let i = 0; i < COUPON_BOX_PICK_BUDGET.perClient * 2; i++) {
            expect(
                (
                    await post(
                        { domain, outline: OUTLINE },
                        { ip: '198.51.100.30' },
                    )
                ).status,
            ).toBe(200)
        }
        expect(chatMock).toHaveBeenCalledTimes(1)
    })
})

// Names as the outline prints them: only words on the extension's word list
// reach the server ("Complete order" arrives as "order").
describe('controls that are not a coupon control', () => {
    const pickOn = async (outline: string, a: object) => {
        chatMock.mockImplementation(async () => answer(a))
        return pickCouponBox({ domain: freshDomain(), outline })
    }
    const SUMMARY = (...lines: string[]) =>
        [
            '- main:',
            '  - region "Order summary":',
            ...lines.map(l => `    ${l}`),
            '    - [9] button "Checkout"',
        ].join('\n')
    const BOX = (button: string, field = 'Promo code') =>
        [
            '- main:',
            '  - form:',
            `    - [1] textbox "${field}"`,
            `    - [2] button "${button}"`,
        ].join('\n')

    // Store credit, a balance and a gift card are not a coupon: applying
    // them drops the total, which reads as a saving that is not one.
    it.each([
        'Use store credit',
        'Apply credit',
        'Apply gift card',
        'Have a gift card?',
        'Check balance',
        'Add protection',
        'Add a gift message',
        'Add to cart',
        'Buy',
    ])('"%s" is never the toggle', async name => {
        expect(
            await pickOn(SUMMARY(`- [5] button "${name}" [collapsed]`), {
                toggle: 5,
            }),
        ).toMatchObject({ outcome: 'no_box' })
    })

    it('a discount reveal under a store credit balance is never the toggle', async () => {
        expect(
            await pickOn(
                SUMMARY(
                    '- heading "Store credit $#.##"',
                    '- [5] button "Apply discount" [collapsed]',
                ),
                { toggle: 5 },
            ),
        ).toMatchObject({ outcome: 'no_box' })
    })

    it.each([
        'Promo code or gift card',
        'Gift card or discount code',
        'Have a promo code?',
    ])('"%s" is still the toggle', async name => {
        expect(
            await pickOn(SUMMARY(`- [5] button "${name}" [collapsed]`), {
                toggle: 5,
            }),
        ).toMatchObject({ outcome: 'box', toggle: 5 })
    })

    it.each([
        'Add to cart',
        'Submit order',
        'order',
        'Buy',
        'Proceed',
        'Next',
        'Apply credit',
        'Add gift wrap',
    ])('"%s" is never the apply button', async name => {
        expect(await pickOn(BOX(name), { input: 1, button: 2 })).toEqual({
            outcome: 'no_pick',
            reason: 'refused_button',
            cached: false,
        })
    })

    it('refuses "Redeem" beside a field only for a gift card code', async () => {
        expect(
            await pickOn(BOX('Redeem', 'Gift card code'), {
                input: 1,
                button: 2,
            }),
        ).toMatchObject({ outcome: 'no_pick', reason: 'refused_button' })
    })

    it('keeps an Apply beside a credit card field heading', async () => {
        expect(
            await pickOn(
                [
                    '- main:',
                    '  - region "Payment":',
                    '    - heading "Credit card"',
                    '    - [1] textbox "Promo code"',
                    '    - [2] button "Apply"',
                ].join('\n'),
                { input: 1, button: 2 },
            ),
        ).toMatchObject({ outcome: 'box', input: 1, button: 2 })
    })

    // A switch or a radio is a setting, and so is a checkbox that does not
    // speak of entering a code or that asks for consent.
    it.each([
        ['switch', 'Have a promo code?'],
        ['checkbox', 'Gift wrap'],
        ['checkbox', 'Email me promo codes and offers'],
        ['checkbox', 'Use my voucher balance'],
    ])('a %s "%s" is never the toggle', async (role, name) => {
        expect(
            await pickOn(SUMMARY(`- [5] ${role} "${name}"`), { toggle: 5 }),
        ).toMatchObject({ outcome: 'no_box' })
    })

    it('a checkbox "Have a promo code?" is the toggle', async () => {
        expect(
            await pickOn(SUMMARY('- [5] checkbox "Have a promo code?"'), {
                toggle: 5,
            }),
        ).toMatchObject({ outcome: 'box', toggle: 5 })
    })
})

// A site footer's links ("Check out our blog") and a bare "total" do not make
// it a cart summary: its "Have A Code?" link still leads off the page.
describe('the page footer', () => {
    const FOOTER = (...lines: string[]) =>
        [
            '- main:',
            '  - [1] link "Classic"',
            '- contentinfo:',
            '  - list:',
            ...lines.map(l => `    ${l}`),
            '    - [5] link "Have A Code?"',
        ].join('\n')

    it.each([
        ['a "Check out our blog" link', '- [3] link "Check out our blog"'],
        ['a "Total" link', '- [3] link "Total"'],
    ])('with %s is still the page footer', async (_, line) => {
        chatMock.mockImplementation(async () => answer({ toggle: 5 }))
        expect(
            await pickCouponBox({
                domain: freshDomain(),
                outline: FOOTER(line),
            }),
        ).toMatchObject({ outcome: 'no_box' })
    })

    it.each([
        ['a "Checkout" button', '- [3] button "Checkout"'],
        ['a subtotal', '- heading "Subtotal $#.##"'],
    ])('with %s is a cart summary', async (_, line) => {
        chatMock.mockImplementation(async () => answer({ toggle: 5 }))
        expect(
            await pickCouponBox({
                domain: freshDomain(),
                outline: FOOTER(line),
            }),
        ).toMatchObject({ outcome: 'box', toggle: 5 })
    })
})

// "Apply Promo Code" above a field heads (and folds) the box; its own "Apply"
// after the field applies the code (onekingslane.com).
describe('a code-naming control above the field', () => {
    const BOX = (after: string) =>
        [
            '- main:',
            '  - [45] button "Remove"',
            '  - [46] button "Apply Promo Code"',
            '  - [2] textbox',
            `  - [47] button "${after}"`,
            '  - [48] button',
        ].join('\n')
    const pick = async (outline: string, button: number) => {
        chatMock.mockImplementation(async () => answer({ input: 2, button }))
        return pickCouponBox({ domain: freshDomain(), outline })
    }

    it('is read as the "Apply" after the field', async () => {
        expect(await pick(BOX('Apply'), 46)).toMatchObject({
            outcome: 'box',
            input: 2,
            button: 47,
        })
    })

    it('is kept when the control after the field is no apply verb', async () => {
        expect(await pick(BOX('Gift wrap options'), 46)).toMatchObject({
            outcome: 'box',
            input: 2,
            button: 46,
        })
    })

    it('leaves a button after the field as the model named it', async () => {
        expect(await pick(BOX('Apply'), 47)).toMatchObject({
            outcome: 'box',
            button: 47,
        })
    })
})

// The extension's spendsPoints and pointsField (coupon-box-discovery.js), on
// the outline: the server keeps and refuses the same controls and fields.
describe('points, store credit and gift cards around the box', () => {
    const pickOn = async (outline: string, a: object) => {
        chatMock.mockImplementation(async () => answer(a))
        return pickCouponBox({ domain: freshDomain(), outline })
    }
    const REWARDS = (...lines: string[]) =>
        [
            '- main:',
            '  - region "Rewards":',
            '    - heading "Rewards"',
            ...lines.map(l => `    ${l}`),
            '  - [9] button "Checkout"',
        ].join('\n')

    // A control that names a code is a code's control wherever it sits.
    it('keeps an "Apply code" button in a Rewards section', async () => {
        expect(
            await pickOn(
                REWARDS(
                    '- [1] textbox "Promo code"',
                    '- [2] button "Apply code"',
                ),
                { input: 1, button: 2 },
            ),
        ).toMatchObject({ outcome: 'box', input: 1, button: 2 })
    })

    it('keeps a "Have a promo code?" toggle in a Rewards section', async () => {
        expect(
            await pickOn(
                REWARDS('- [5] button "Have a promo code?" [collapsed]'),
                { toggle: 5 },
            ),
        ).toMatchObject({ outcome: 'box', toggle: 5 })
    })

    it.each(['Redeem ### points for a $# code', 'Apply store credit', 'Apply'])(
        'still refuses "%s" in a Rewards section',
        async name => {
            expect(
                await pickOn(
                    REWARDS('- [1] textbox', `- [2] button "${name}"`),
                    { input: 1, button: 2 },
                ),
            ).toMatchObject({ outcome: 'no_pick', reason: 'refused_button' })
        },
    )

    // A plain "Apply" spends a balance when store credit or a gift card's
    // number is what sits around it.
    it.each([
        [
            'under a store credit heading',
            [
                '- main:',
                '  - region "Order summary":',
                '    - heading "Store credit $#.##"',
                '    - [1] textbox',
                '    - [2] button "Apply"',
            ],
        ],
        [
            'beside "Check balance", the field naming no code',
            [
                '- main:',
                '  - form:',
                '    - [1] textbox',
                '    - [2] button "Apply"',
                '    - [3] button "Check balance"',
            ],
        ],
        [
            'beside a gift card number field',
            [
                '- main:',
                '  - form:',
                '    - [1] textbox "Gift card number"',
                '    - [2] button "Apply"',
            ],
        ],
    ])('refuses a plain "Apply" %s', async (_, lines) => {
        expect(
            await pickOn(lines.join('\n'), { input: 1, button: 2 }),
        ).toMatchObject({ outcome: 'no_pick', reason: 'refused_button' })
    })

    it.each([
        [
            'beside "Check balance" in a promo box',
            [
                '- main:',
                '  - form:',
                '    - [1] textbox "Promo code"',
                '    - [2] button "Apply"',
                '    - [3] button "Check balance"',
            ],
        ],
        [
            'under a store credit heading beside a promo code field',
            [
                '- main:',
                '  - region "Order summary":',
                '    - heading "Store credit $#.##"',
                '    - [1] textbox "Promo code"',
                '    - [2] button "Apply"',
            ],
        ],
    ])('keeps a plain "Apply" %s', async (_, lines) => {
        expect(
            await pickOn(lines.join('\n'), { input: 1, button: 2 }),
        ).toMatchObject({ outcome: 'box', input: 1, button: 2 })
    })

    // The extension reads at most 1000 characters of the words beside a
    // control (RULE_WORDS_MAX); a word past them is not read here either.
    it('reads no more of the words beside a control than the extension does', async () => {
        const links = Array.from(
            { length: 40 },
            (_, i) =>
                `      - [${100 + i}] link "Shop all new arrivals and sale"`,
        )
        const outline = (last: string) =>
            [
                '- main:',
                '  - form:',
                '    - [1] textbox',
                '    - [2] button "Apply"',
                '    - list:',
                ...(last === 'first' ? [] : links),
                '      - [99] link "Use your points"',
                ...(last === 'first' ? links : []),
            ].join('\n')
        expect(
            await pickOn(outline('last'), { input: 1, button: 2 }),
        ).toMatchObject({ outcome: 'box', input: 1, button: 2 })
        expect(
            await pickOn(outline('first'), { input: 1, button: 2 }),
        ).toMatchObject({ outcome: 'no_pick', reason: 'refused_button' })
    })

    // Underscores read as spaces, as the extension reads a control's words.
    it('reads "Use_member_discount" as a member discount, never the toggle', async () => {
        expect(
            await pickOn(
                [
                    '- main:',
                    '  - region "Order summary":',
                    '    - [5] button "Use_member_discount" [collapsed]',
                    '    - [9] button "Checkout"',
                ].join('\n'),
                { toggle: 5 },
            ),
        ).toMatchObject({ outcome: 'no_box' })
    })

    // Typing a code into a points or store credit field and pressing Enter
    // spends them.
    it.each(['Points to redeem', 'Store credit', 'Rewards number', 'Balance'])(
        'refuses a "%s" field',
        async field => {
            expect(
                await pickOn(
                    [
                        '- main:',
                        '  - form:',
                        `    - [1] textbox "${field}"`,
                        '  - [9] button "Checkout"',
                    ].join('\n'),
                    { input: 1 },
                ),
            ).toMatchObject({ outcome: 'no_box' })
        },
    )

    it.each(['Promo or rewards code', 'Credit card or promo code', 'Voucher'])(
        'keeps a "%s" field',
        async field => {
            expect(
                await pickOn(
                    [
                        '- main:',
                        '  - form:',
                        `    - [1] textbox "${field}"`,
                        '  - [9] button "Checkout"',
                    ].join('\n'),
                    { input: 1 },
                ),
            ).toMatchObject({ outcome: 'box', input: 1 })
        },
    )
})

// Every label in the live eval's fixtures, handed back as the model's answer,
// must survive the server's own checks: a labelled box the server refuses is a
// case no model can pass, and the eval would read it as the model's miss.
describe('the eval fixtures', () => {
    const labelled = couponBoxCases.filter(
        c => !c.knownMiss && (c.inputs.length > 0 || c.toggles.length > 0),
    )
    const picks = labelled.flatMap(c => [
        ...c.inputs.map(input => ({
            c,
            a: { input, button: c.buttons?.[0] ?? null },
        })),
        ...c.toggles.map(toggle => ({ c, a: { toggle } })),
    ])

    it.each(picks.map(p => [`${p.c.store} ${JSON.stringify(p.a)}`, p]))(
        '%s is accepted',
        async (_, { c, a }) => {
            chatMock.mockImplementation(async () => answer(a))
            expect(
                await pickCouponBox({
                    domain: freshDomain(),
                    outline: c.outline,
                }),
            ).toMatchObject({ outcome: 'box', input: null, toggle: null, ...a })
        },
    )

    it('the known miss is refused, as its note says', async () => {
        const misses = couponBoxCases.filter(c => c.knownMiss)
        expect(misses.map(c => c.store)).toEqual(['coversandall.com'])
        for (const c of misses) {
            chatMock.mockImplementation(async () =>
                answer({ toggle: c.toggles[0] }),
            )
            expect(
                await pickCouponBox({
                    domain: freshDomain(),
                    outline: c.outline,
                }),
            ).toMatchObject({ outcome: 'no_box' })
        }
    })
})
