// @vitest-environment jsdom
import FaqSection from '@/components/FaqSection'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

// AEO citable-surface gate — the landing FAQ exists so AI answer engines can
// quote VISIBLE copy, and its FAQPage JSON-LD must mirror that visible copy
// EXACTLY (a drifted script would make engines cite text no human can see on
// the page). Both are generated from one array inside FaqSection, and this
// suite pins that contract from the rendered output, not the source.
//
// FaqSection is a server component built on native <details>/<summary>, so a
// plain jsdom render produces the full final DOM (no framer, no effects).

type FaqJsonLd = {
    '@context': string
    '@type': string
    mainEntity: Array<{
        '@type': string
        name: string
        acceptedAnswer: { '@type': string; text: string }
    }>
}

function renderAndParseJsonLd() {
    const { container } = render(<FaqSection />)
    const script = container.querySelector('script[type="application/ld+json"]')
    expect(script, 'FAQ JSON-LD script must be rendered').toBeTruthy()
    const data = JSON.parse(script!.textContent || '') as FaqJsonLd
    return { container, data }
}

afterEach(cleanup)

describe('FaqSection — visible copy is the source of truth for the JSON-LD', () => {
    it('renders the section heading and one <details> accordion item per question', () => {
        const { container, data } = renderAndParseJsonLd()

        expect(
            screen.getByRole('heading', {
                name: 'Frequently Asked Questions',
            }),
        ).toBeTruthy()

        const detailsEls = container.querySelectorAll('details')
        expect(detailsEls.length).toBe(data.mainEntity.length)
        expect(detailsEls.length).toBeGreaterThanOrEqual(5)
    })

    it('every JSON-LD question and answer appears VERBATIM in the visible DOM', () => {
        const { data } = renderAndParseJsonLd()

        expect(data['@type']).toBe('FAQPage')
        for (const entity of data.mainEntity) {
            expect(entity['@type']).toBe('Question')
            // getByText throws on missing AND on duplicates — so this also
            // proves each Q/A pair renders exactly once.
            expect(screen.getByText(entity.name)).toBeTruthy()
            expect(screen.getByText(entity.acceptedAnswer.text)).toBeTruthy()
        }
    })

    it('answers are in the DOM even while collapsed (engines read HTML, not open state)', () => {
        const { container } = renderAndParseJsonLd()
        for (const details of Array.from(
            container.querySelectorAll('details'),
        )) {
            expect(details.hasAttribute('open')).toBe(false)
            expect(
                details.querySelector('p')?.textContent?.length ?? 0,
            ).toBeGreaterThan(50)
        }
    })

    it('carries NO review/rating markup (claim-integrity rule: no invented social proof)', () => {
        const { container } = renderAndParseJsonLd()
        const raw =
            container.querySelector('script[type="application/ld+json"]')!
                .textContent || ''
        expect(raw).not.toMatch(/aggregateRating|reviewRating|"Review"/i)
    })

    it('states only verified numbers: 139,000+ codes and 3,000+ stores, rounded DOWN', () => {
        renderAndParseJsonLd()
        expect(
            screen.getByText(/over 139,000 active coupon codes/),
        ).toBeTruthy()
        expect(screen.getByText(/more than 3,000 online stores/)).toBeTruthy()
    })
})
