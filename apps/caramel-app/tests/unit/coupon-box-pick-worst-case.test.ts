import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The pick reads a guest's outline on the request's own thread: every rule in
// src/lib/couponBoxPick.ts runs on names and outlines the caller wrote, up to
// MAX_OUTLINE_BYTES. A pattern that backtracks on a crafted name blocks the
// event loop for every other request, so each one is timed here on the
// inputs that make its kind of pattern slow.

// MOCK (announced): `chat` is the paid model call. It answers instantly with
// the indexes each case names, so the time measured is the server's own.
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

import { MAX_OUTLINE_BYTES, pickCouponBox } from '@/lib/couponBoxPick'
import { resetCouponBoxPickBudgetForTests } from '@/lib/couponBoxPickBudget'

const LIMIT_MS = 50

beforeEach(() => {
    envMock.COUPON_BOX_LLM_ENABLED = true
    envMock.COUPON_BOX_PICK_MODEL = 'test/box-model'
    resetCouponBoxPickBudgetForTests()
})

/** `unit` repeated to fill a third of the largest outline the pick takes. */
const fill = (unit: string, head = '', room = (MAX_OUTLINE_BYTES - 400) / 3) =>
    head + unit.repeat(Math.floor((room - head.length) / unit.length))

/** The crafted name on every line the answer names, so the input, toggle and
 * button checks all read it. A checkbox toggle is also read by the checks
 * that tell a fold from a setting. */
const oneNameOutline = (name: string, toggleRole = 'button') =>
    [
        '- main:',
        '  - region "Order summary":',
        `    - [1] textbox "${name}"`,
        `    - [2] button "${name}"`,
        `    - [3] ${toggleRole} "${name}"`,
    ].join('\n')

// A name made of one repeated piece: the shape each kind of pattern
// backtracks on (a long word, a word with no end, a phrase that keeps
// restarting).
const NAMES: [string, string][] = [
    ['one long word', fill('a')],
    ['one long run of dashes', fill('-')],
    ['dots between letters', fill('a.')],
    ['an address with no domain end', fill('a', 'shop@')],
    ['redeem, then "for" without end', fill(' for', 'redeem')],
    ['redeem for, then no code word', fill('a', 'redeem for ')],
    ['redeem over and over', fill('redeem ')],
    ['redeem for over and over', fill('redeem for ')],
    ['"or" phrases with no code', fill('a or ')],
    ['words before no code', fill('word ')],
    ['quotes', fill('"')],
    ['states with no end', fill(' [a')],
    ['place order spellings', fill('place my ')],
    ['prices', fill('$#.## ')],
    ['code words', fill('promo code ')],
    ['a code-entry verb, then spaces with no code word', fill(' ', 'have')],
    ['loyalty words', fill('points rewards ')],
]

// Page shapes that make the tree walks (the words beside a control, its
// section, the page footer) slow: a very flat page, a very deep one, and a
// deep one with many blocks at every level.
function flatOutline(): string {
    const lines = ['- main:', '  - region "Order summary":']
    for (let n = 10; lines.join('\n').length < MAX_OUTLINE_BYTES - 200; n++)
        lines.push(`    - [${n}] button "Apply"`)
    lines.push('    - [1] textbox "Promo code"', '    - [3] button "Discount"')
    return lines.join('\n')
}

function deepOutline(perLevel: number): string {
    const lines: string[] = []
    let n = 10
    for (let d = 0; ; d++) {
        const pad = '  '.repeat(d)
        const level = [
            `${pad}- region "Order summary":`,
            ...Array.from(
                { length: perLevel },
                () =>
                    `${pad}  - group:\n${pad}    - heading "Your #"\n${pad}    - [${n++}] textbox "Qty"`,
            ),
        ]
        if (
            lines.join('\n').length + level.join('\n').length >
            MAX_OUTLINE_BYTES - 400
        ) {
            lines.push(
                `${pad}- [1] textbox "Promo code"`,
                `${pad}- [3] button "Discount"`,
            )
            return lines.join('\n')
        }
        lines.push(...level)
    }
}

function footersOutline(): string {
    const lines: string[] = []
    for (let n = 10; lines.join('\n').length < MAX_OUTLINE_BYTES - 200; n++)
        lines.push('- contentinfo:', `  - [${n}] link "Help"`)
    lines.push('- contentinfo:', '  - [3] button "Discount"')
    lines.unshift('- main:', '  - [1] textbox "Promo code"')
    return lines.join('\n')
}

const SHAPES: [string, () => string][] = [
    ['a flat page', flatOutline],
    ['a deep page', () => deepOutline(1)],
    ['a deep page with blocks at every level', () => deepOutline(6)],
    ['many page footers', footersOutline],
]

const timed = async (outline: string) => {
    expect(new TextEncoder().encode(outline).length).toBeLessThanOrEqual(
        MAX_OUTLINE_BYTES,
    )
    chatMock.mockImplementation(async () =>
        JSON.stringify({ input: 1, button: 2, toggle: 3, confidence: 90 }),
    )
    const started = performance.now()
    await pickCouponBox({
        domain: `shop-${randomUUID().slice(0, 8)}.example`,
        outline,
    })
    return performance.now() - started
}

describe('a crafted outline cannot block the server', () => {
    it.each(NAMES)(
        `a name of %s is read in under ${LIMIT_MS}ms`,
        async (_, name) => {
            expect(await timed(oneNameOutline(name))).toBeLessThan(LIMIT_MS)
        },
    )

    it.each(NAMES)(
        `a checkbox toggle named %s is read in under ${LIMIT_MS}ms`,
        async (_, name) => {
            expect(await timed(oneNameOutline(name, 'checkbox'))).toBeLessThan(
                LIMIT_MS,
            )
        },
    )

    it.each(SHAPES)(`%s is read in under ${LIMIT_MS}ms`, async (_, make) => {
        expect(await timed(make())).toBeLessThan(LIMIT_MS)
    })
})
