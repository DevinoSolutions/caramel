import { couponPlainText } from '@/lib/couponPlainText'
import { describe, expect, it } from 'vitest'

// Shapes taken from the live catalog, 2026-10-29 (see couponPlainText.ts).
describe('couponPlainText', () => {
    it('decodes the entities the supplier stores', () => {
        expect(couponPlainText('Books, music &amp; video games')).toBe(
            'Books, music & video games',
        )
        expect(couponPlainText('Kohl&#039;s Cash')).toBe("Kohl's Cash")
        expect(couponPlainText('&quot;VIP&quot; &#x27;deal&#x27;')).toBe(
            `"VIP" 'deal'`,
        )
        expect(couponPlainText('&lt;&lt;COUPONS UPDATE TODAY&gt;&gt;')).toBe(
            '<<COUPONS UPDATE TODAY>>',
        )
    })

    it('turns an escaped line break into a space', () => {
        expect(
            couponPlainText(
                'Prices are shown with discounts applied.&lt;br&gt; &lt;br&gt; *Free Pro-Grade Bypass Kit',
            ),
        ).toBe(
            'Prices are shown with discounts applied. *Free Pro-Grade Bypass Kit',
        )
    })

    it('decodes a doubly escaped entity', () => {
        expect(couponPlainText('Kohl&amp;#039;s')).toBe("Kohl's")
    })

    it('decodes twice at most', () => {
        expect(couponPlainText('&amp;amp;amp;')).toBe('&amp;')
    })

    it('leaves text with no entity untouched, spacing included', () => {
        const text = '  20% off  sitewide '
        expect(couponPlainText(text)).toBe(text)
    })

    it('leaves an unknown or unsafe entity as it was', () => {
        expect(couponPlainText('A &bogus; B')).toBe('A &bogus; B')
        expect(couponPlainText('A &#0; B &#x110000; C')).toBe(
            'A &#0; B &#x110000; C',
        )
    })

    it('drops escaped inline formatting tags and keeps their words', () => {
        expect(couponPlainText('Save &lt;b&gt;big&lt;/b&gt; &amp; more')).toBe(
            'Save big & more',
        )
    })

    it('keeps any other less-than as written', () => {
        expect(couponPlainText('Orders &lt; $50 &amp; &lt;script&gt;')).toBe(
            'Orders < $50 & <script>',
        )
    })
})
