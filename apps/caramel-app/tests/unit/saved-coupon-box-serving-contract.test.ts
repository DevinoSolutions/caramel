import { isCouponBoxSelector } from '@/lib/couponBoxSelector'
import {
    getSupportedStoresPayload,
    resetSupportedStoresCache,
} from '@/lib/supportedStoresCache'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// "A saved box reaches the extension in the shape it reads", in two halves:
//
//   1. The extension reads a config selector as XPath when it starts with
//      `/`, `(/` or `./` (dom-utils.js _isXPath) and as CSS otherwise. Nothing
//      the server's grammar accepts starts that way, so a saved CSS box is
//      always read as CSS.
//   2. The supported-stores builder maps a saved row (CSS, order total set,
//      the four pipeline-only selectors NULL) to exactly the keys a pipeline
//      row gets, with no `origin` and no undefined-valued keys, so one saved
//      row cannot empty or reshape the list.

const { queryRawMock } = vi.hoisted(() => ({ queryRawMock: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ default: { $queryRaw: queryRawMock } }))

// What insertAutoDetectedStoreConfig writes for an Enter-only box with a
// toggle, as listSupportedStoreConfigs returns
// it (origin is not selected).
const SAVED_ROW = {
    store_name: 'shop-example.com',
    show_input_xpath: 'button.reveal-promo',
    dismiss_button_xpath: null,
    coupon_input_xpath: 'form#cart > input[name="code"]',
    apply_button_xpath: 'form#cart > input[name="code"]',
    price_container_xpath: '.order-total',
    success_indicator_xpath: null,
    error_indicator_xpath: null,
    coupon_remove_xpath: null,
}

// The extension's own rule, copied so the pin is explicit about what it
// protects against; it is not imported because the extension module touches
// browser globals at load.
const extensionReadsAsXPath = (sel: string) =>
    sel.trim().startsWith('/') ||
    sel.trim().startsWith('(/') ||
    sel.trim().startsWith('./')

beforeEach(() => {
    resetSupportedStoresCache()
    queryRawMock.mockReset()
    queryRawMock.mockResolvedValue([SAVED_ROW])
})

describe('a saved box in the store list', () => {
    it.each([
        '/html//input',
        '//input[@id="promo"]',
        '(//input)[1]',
        './input',
        ' //input',
    ])(
        'the grammar refuses %s, so nothing it accepts is read as XPath',
        sel => {
            expect(extensionReadsAsXPath(sel)).toBe(true)
            expect(isCouponBoxSelector(sel)).toBe(false)
        },
    )

    it.each([
        '#promo',
        'input[name=code]',
        'form#cart > input[name="code"]',
        'div.promo input',
        '.-x-promo',
    ])('%s is accepted and is read as CSS by the extension', sel => {
        expect(isCouponBoxSelector(sel)).toBe(true)
        expect(extensionReadsAsXPath(sel)).toBe(false)
    })

    it('is served with exactly the keys the extension reads, no origin, no undefined values', async () => {
        const { body } = await getSupportedStoresPayload(1_000)
        const parsed = JSON.parse(body) as {
            supported: Record<string, unknown>[]
            gated: unknown[]
        }
        expect(parsed.gated).toEqual([])
        expect(parsed.supported).toEqual([
            {
                domain: 'shop-example.com',
                couponInput: 'form#cart > input[name="code"]',
                couponSubmit: 'form#cart > input[name="code"]',
                priceContainer: '.order-total',
                showInput: 'button.reveal-promo',
            },
        ])
        expect(body).not.toContain('origin')
        expect(body).not.toContain('auto_detect')
    })

    it('a saved row beside a pipeline row leaves the pipeline row byte-identical', async () => {
        const PIPELINE_ROW = {
            ...SAVED_ROW,
            store_name: 'pipeline.com',
            show_input_xpath: null,
            coupon_input_xpath: '//input[@id="promo"]',
            apply_button_xpath: '//button[@id="apply"]',
            price_container_xpath: null,
        }
        queryRawMock.mockResolvedValue([PIPELINE_ROW, SAVED_ROW])
        const { body } = await getSupportedStoresPayload(2_000)
        const { supported } = JSON.parse(body) as {
            supported: Record<string, unknown>[]
        }
        expect(supported[0]).toEqual({
            domain: 'pipeline.com',
            couponInput: '//input[@id="promo"]',
            couponSubmit: '//button[@id="apply"]',
        })
        expect(supported).toHaveLength(2)
    })
})
