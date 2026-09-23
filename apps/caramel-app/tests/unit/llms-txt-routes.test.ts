import { GET as getLlmsFull } from '@/app/llms-full.txt/route'
import { GET as getLlms } from '@/app/llms.txt/route'
import { faqItems } from '@/lib/faqItems'
import { describe, expect, it } from 'vitest'

// The two answer-engine text assets. e2e/seo-regression.spec.ts proves they
// are SERVED (200, text/plain); this pins their CONTENT contract at unit
// level, where the FAQ array is importable: llms-full.txt must carry every
// landing-FAQ question and answer verbatim (one array feeds the accordion,
// the FAQPage JSON-LD and this document — src/lib/faqItems.ts), and llms.txt
// must point at the full document so an engine that only reads the index
// card can find it.

describe('llms.txt + llms-full.txt', () => {
    it('llms-full.txt renders every FAQ question and answer verbatim', async () => {
        const res = getLlmsFull()
        expect(res.headers.get('content-type')).toContain('text/plain')
        const body = await res.text()
        expect(body.startsWith('# Caramel\n')).toBe(true)
        expect(faqItems.length).toBeGreaterThanOrEqual(5)
        for (const { question, answer } of faqItems) {
            expect(body).toContain(`### ${question}`)
            expect(body).toContain(answer)
        }
        expect(body).toMatch(/\/privacy\b/)
        expect(body).toContain('https://devino.ca')
        // Claim-integrity rule carries over: no invented social proof.
        expect(body).not.toMatch(/aggregateRating|reviewRating|"Review"/i)
    })

    it('llms.txt links the full document', async () => {
        const body = await getLlms().text()
        expect(body).toMatch(/\/llms-full\.txt\)/)
    })
})
