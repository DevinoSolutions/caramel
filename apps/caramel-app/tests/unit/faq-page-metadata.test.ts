import { metadata } from '@/app/(marketing)/faq/page'
import { describe, expect, it } from 'vitest'

// SEO measurement freeze (2026-10-02, re-measure after 2026-10-23): the /faq
// title and meta description must not move while the window runs. The
// description used to interpolate faqItems.length, so adding a FAQ item moved
// it silently; this pins the exact strings. See the TODO in faq/page.tsx for
// when to relax this.
describe('/faq metadata is frozen during the SEO measurement window', () => {
    it('keeps the exact title and description', () => {
        expect(metadata.title).toBe(
            'Caramel FAQ — free coupon extension questions answered',
        )
        expect(metadata.description).toBe(
            '10 answers about the free, open-source Caramel coupon extension: browsers, privacy, affiliate links, how codes are found and applied.',
        )
    })
})
