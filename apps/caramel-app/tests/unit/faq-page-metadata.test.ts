import { metadata } from '@/app/(marketing)/faq/page'
import { faqItems } from '@/lib/faqItems'
import { describe, expect, it } from 'vitest'

describe('/faq metadata', () => {
    it('title is stable', () => {
        expect(metadata.title).toBe(
            'Caramel FAQ — free coupon extension questions answered',
        )
    })

    it('description tracks the FAQ count', () => {
        expect(metadata.description).toBe(
            `${faqItems.length} answers about the free, open-source Caramel coupon extension: browsers, privacy, affiliate links, how codes are found and applied.`,
        )
    })
})
