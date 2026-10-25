import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    _caramelResetDiscoveryFlag,
    caramelDiscoveredRecord,
    caramelFindOrderTotal,
} from '../coupon-box-discovery.js'
import { caramelFindMoney } from '../dom-utils.js'
import {
    NO_CONFIG,
    installChromeStub,
    setPath,
    stubLayout,
} from './_found-box-harness.mjs'

// Battle test, round 2 (T-8654): the order total on carts written in the
// languages round 1 did not cover, carts that show only a subtotal in their
// own language, and summaries whose subtotal line starts with the same word
// as the total ("Totale parziale" / "Totale", "Ara toplam" / "Toplam").
// The total is what a code is judged on: no total, no auto-apply; the wrong
// row, a wrong saving.

vi.mock('../coupon-apply.js', async importOriginal => ({
    ...(await importOriginal()),
    applyCoupon: async () => ({ success: false, applied: false }),
    probeCartJson: async () => null,
}))
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
        sleep: async () => {},
    }
})

beforeAll(() => {
    installChromeStub()
    initCaramelBase()
    stubLayout()
})

beforeEach(() => {
    _caramelResetDiscoveryFlag()
    setPath('/checkout')
})

const textOf = sel => (sel ? document.querySelector(sel)?.textContent : null)

const BOX =
    '<div class="promo"><label for="c">Promo code</label>' +
    '<input id="c" type="text" name="coupon"><button id="b" type="button">Apply</button></div>'
const summary = rows =>
    '<div class="summary">' +
    rows
        .map(
            ([l, v]) =>
                `<div class="row"><span>${l}</span><span>${v}</span></div>`,
        )
        .join('') +
    '</div>'

/* ====================================================== totals by language */
// [locale, rows, the amount the total row shows]
const TOTALS = [
    [
        'Danish',
        [
            ['Subtotal', '899,00 kr.'],
            ['Fragt', '39,00 kr.'],
            ['I alt', '938,00 kr.'],
        ],
        '938,00 kr.',
    ],
    [
        'Norwegian',
        [
            ['Delsum', '1 199,00 kr'],
            ['Frakt', '99,00 kr'],
            ['Å betale', '1 298,00 kr'],
        ],
        '1 298,00 kr',
    ],
    [
        'Czech',
        [
            ['Mezisoučet', '1 290 Kč'],
            ['Doprava', '89 Kč'],
            ['Celkem k úhradě', '1 379 Kč'],
        ],
        '1 379 Kč',
    ],
    [
        'Slovak',
        [
            ['Medzisúčet', '49,90 €'],
            ['Doprava', '3,90 €'],
            ['Spolu', '53,80 €'],
        ],
        '53,80 €',
    ],
    [
        'Turkish',
        [
            ['Ara Toplam', '1.249,90 TL'],
            ['Kargo', '49,90 TL'],
            ['Genel Toplam', '1.299,80 TL'],
        ],
        '1.299,80 TL',
    ],
    [
        'Turkish (Toplam)',
        [
            ['Ara toplam', '₺1.249,90'],
            ['Toplam', '₺1.299,80'],
        ],
        '₺1.299,80',
    ],
    [
        'Russian',
        [
            ['Товары', '4 590 ₽'],
            ['Доставка', '300 ₽'],
            ['Итого', '4 890 ₽'],
        ],
        '4 890 ₽',
    ],
    [
        'Ukrainian',
        [
            ['Товари', '1 299 ₴'],
            ['Доставка', '70 ₴'],
            ['Разом', '1 369 ₴'],
        ],
        '1 369 ₴',
    ],
    [
        'Hungarian',
        [
            ['Részösszeg', '12 990 Ft'],
            ['Szállítás', '1 490 Ft'],
            ['Összesen', '14 480 Ft'],
        ],
        '14 480 Ft',
    ],
    [
        'Romanian',
        [
            ['Subtotal', '249,99 lei'],
            ['Livrare', '15,99 lei'],
            ['Total comandă', '265,98 lei'],
        ],
        '265,98 lei',
    ],
    [
        'Greek',
        [
            ['Υποσύνολο', '59,90 €'],
            ['Μεταφορικά', '3,50 €'],
            ['Σύνολο', '63,40 €'],
        ],
        '63,40 €',
    ],
    [
        'Portuguese (PT)',
        [
            ['Subtotal', '1.234,56 €'],
            ['Portes', '4,99 €'],
            ['Total', '1.239,55 €'],
        ],
        '1.239,55 €',
    ],
    [
        'Brazilian (Valor total)',
        [
            ['Subtotal', 'R$ 199,90'],
            ['Frete', 'R$ 19,90'],
            ['Valor total', 'R$ 219,80'],
        ],
        'R$ 219,80',
    ],
    [
        'Korean',
        [
            ['상품금액', '₩39,000'],
            ['배송비', '₩3,000'],
            ['총 결제금액', '₩42,000'],
        ],
        '₩42,000',
    ],
    [
        'Korean (원)',
        [
            ['상품금액', '39,000원'],
            ['배송비', '3,000원'],
            ['결제금액', '42,000원'],
        ],
        '42,000원',
    ],
    [
        'Chinese (simplified)',
        [
            ['小计', '¥299.00'],
            ['运费', '¥10.00'],
            ['总计', '¥309.00'],
        ],
        '¥309.00',
    ],
    [
        'Chinese (合计)',
        [
            ['商品金额', '¥299.00'],
            ['合计', '¥309.00'],
        ],
        '¥309.00',
    ],
    [
        'Chinese (traditional)',
        [
            ['小計', 'NT$1,290'],
            ['運費', 'NT$60'],
            ['總計', 'NT$1,350'],
        ],
        'NT$1,350',
    ],
    [
        'Hebrew',
        [
            ['סכום ביניים', '₪199.90'],
            ['משלוח', '₪29.90'],
            ['סה"כ לתשלום', '₪229.80'],
        ],
        '₪229.80',
    ],
    [
        'Thai',
        [
            ['ยอดรวมย่อย', '฿1,290.00'],
            ['ค่าจัดส่ง', '฿50.00'],
            ['ยอดรวมทั้งสิ้น', '฿1,340.00'],
        ],
        '฿1,340.00',
    ],
    [
        'Vietnamese',
        [
            ['Tạm tính', '450.000₫'],
            ['Phí vận chuyển', '30.000₫'],
            ['Tổng cộng', '480.000₫'],
        ],
        '480.000₫',
    ],
    [
        'Indonesian',
        [
            ['Subtotal', 'Rp 250.000'],
            ['Ongkos kirim', 'Rp 15.000'],
            ['Total Pembayaran', 'Rp 265.000'],
        ],
        'Rp 265.000',
    ],
    [
        'Arabic',
        [
            ['المجموع الفرعي', '199.00 AED'],
            ['الشحن', '15.00 AED'],
            ['الإجمالي', '214.00 AED'],
        ],
        '214.00 AED',
    ],
]

describe.each(TOTALS)('%s cart', (_locale, rows, total) => {
    it('reads the order total, not the subtotal', () => {
        document.body.innerHTML = BOX + summary(rows)
        expect(caramelFindOrderTotal()?.textContent).toContain(total)
    })

    it('hands the apply flow a record measured on that total', async () => {
        document.body.innerHTML = BOX + summary(rows)
        const rec = await caramelDiscoveredRecord(NO_CONFIG)
        expect(rec).not.toBeNull()
        expect(textOf(rec.priceContainer)).toContain(total)
    })
})

/* ================================================== subtotal-only carts */
// A cart page that shows only a subtotal (shipping and tax come at checkout)
// is measured on that subtotal. Round 1 read the English word only.
const SUBTOTAL_ONLY = [
    ['German', 'Zwischensumme', '89,90 €'],
    ['French', 'Sous-total', '89,90 €'],
    ['Dutch', 'Subtotaal', '€ 89,90'],
    ['Italian', 'Subtotale', '89,90 €'],
    ['Swedish', 'Delsumma', '899,00 kr'],
    ['Finnish', 'Välisumma', '89,90 €'],
    ['Polish', 'Suma częściowa', '199,99 zł'],
    ['Japanese', '小計', '¥4,480'],
    ['Portuguese', 'Subtotal', 'R$ 199,90'],
    ['Czech', 'Mezisoučet', '1 290 Kč'],
    ['Turkish', 'Ara Toplam', '1.249,90 TL'],
]

describe.each(SUBTOTAL_ONLY)(
    '%s cart showing only a subtotal',
    (_l, label, amount) => {
        it('is measured on that subtotal', () => {
            document.body.innerHTML = BOX + summary([[label, amount]])
            expect(caramelFindOrderTotal()?.textContent).toContain(amount)
        })
    },
)

/* ============================================ subtotals that look like totals */
// Each summary's subtotal line starts with (or contains) the total's own word
// and comes AFTER the real total in the markup (some themes print the
// breakdown under the headline amount), so "the last total row" would be the
// subtotal if it were read as a total.
const LOOKALIKES = [
    [
        'Italian',
        [
            ['Totale', '94,89 €'],
            ['Totale parziale', '89,90 €'],
        ],
        '94,89 €',
    ],
    [
        'Turkish',
        [
            ['Toplam', '1.299,80 TL'],
            ['Ara toplam', '1.249,90 TL'],
        ],
        '1.299,80 TL',
    ],
    [
        'Spanish',
        [
            ['Total', '84,89 €'],
            ['Total parcial', '79,90 €'],
        ],
        '84,89 €',
    ],
    [
        'Portuguese',
        [
            ['Total', 'R$ 219,80'],
            ['Total parcial', 'R$ 199,90'],
        ],
        'R$ 219,80',
    ],
    [
        'Polish',
        [
            ['Razem', '219,98 zł'],
            ['Suma częściowa', '199,99 zł'],
        ],
        '219,98 zł',
    ],
    [
        'Swedish',
        [
            ['Totalt', '998,00 kr'],
            ['Totalt för varor', '899,00 kr'],
        ],
        '998,00 kr',
    ],
    [
        'German',
        [
            ['Gesamtsumme', '94,89 €'],
            ['Gesamt netto', '79,74 €'],
        ],
        '94,89 €',
    ],
    [
        'English',
        [
            ['Total', '$94.89'],
            ['Total before tax', '$89.90'],
        ],
        '$94.89',
    ],
]

describe.each(LOOKALIKES)('%s summary', (_l, rows, total) => {
    it('measures the real total, not the subtotal that shares its word', () => {
        document.body.innerHTML = BOX + summary(rows)
        expect(caramelFindOrderTotal()?.textContent).toContain(total)
    })
})

/* ========================================================== the amounts */
describe('amounts in the currencies these carts price in', () => {
    it.each([
        ['42,000원', 42000],
        ['₩42,000', 42000],
        ['309.00元', 309],
        ['¥309.00', 309],
        ['1 379 Kč', 1379],
        ['1.299,80 TL', 1299.8],
        ['4 890 ₽', 4890],
        ['14 480 Ft', 14480],
        ['265,98 lei', 265.98],
        ['NT$1,350', 1350],
        ['Rp 265.000', 265000],
        ['480.000₫', 480000],
        ['₪229.80', 229.8],
    ])('%s', (text, value) => {
        const [hit] = caramelFindMoney(text)
        expect(hit?.value).toBeCloseTo(value, 2)
    })
})
