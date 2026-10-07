// @vitest-environment jsdom
import CompareCouponExtensionsPage from '@/app/(marketing)/compare/coupon-extensions/page'
import { GET as getLlmsFull } from '@/app/llms-full.txt/route'
import { GET as getLlms } from '@/app/llms.txt/route'
import { faqPageJsonLd } from '@/lib/jsonLd'
import {
    COMPARED_EXTENSIONS,
    COMPARISON_FAQ,
    COMPARISON_PATH,
    COMPARISON_PICKS,
    COMPARISON_SOURCES,
    COMPARISON_SUMMARY,
    HONEY_TIMELINE,
    comparisonSourceOrder,
    type ComparisonSourceId,
} from '@/lib/seo/extensionComparison'
import { EXTENSION_STAMP_ATTRIBUTE } from '@/lib/surface/detectSurface'
import { SurfaceProvider } from '@/lib/surface/SurfaceProvider'
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// /compare/coupon-extensions makes public statements about competitors, so
// the claim-integrity rules in src/lib/seo/extensionComparison.ts are pinned
// here: every row and timeline event cites a source that exists, every
// source is cited and linked, the FAQPage JSON-LD is the visible FAQ, and
// /llms-full.txt carries the same text an answer engine sees on the page.

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))
vi.mock('@/lib/analytics/growthEvents', () => ({ trackGrowthEvent: trackMock }))

function mount() {
    return render(
        <SurfaceProvider>
            <CompareCouponExtensionsPage />
        </SurfaceProvider>,
    )
}

function citedIds(): ComparisonSourceId[] {
    return [
        ...COMPARED_EXTENSIONS.flatMap(row => row.sources),
        ...HONEY_TIMELINE.flatMap(event => event.sources),
    ]
}

beforeEach(() => {
    trackMock.mockReset()
    document.documentElement.removeAttribute(EXTENSION_STAMP_ATTRIBUTE)
    Object.defineProperty(window.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        configurable: true,
    })
})
afterEach(cleanup)

describe('extensionComparison data', () => {
    it('every row and event cites at least one source, and every source is cited', () => {
        for (const row of COMPARED_EXTENSIONS) {
            expect(row.sources.length, row.name).toBeGreaterThan(0)
        }
        for (const event of HONEY_TIMELINE) {
            expect(event.sources.length, event.date).toBeGreaterThan(0)
            expect(event.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        }
        expect(new Set(citedIds())).toEqual(
            new Set(Object.keys(COMPARISON_SOURCES)),
        )
        expect(comparisonSourceOrder()).toEqual(Array.from(new Set(citedIds())))
    })

    it('every source links over https', () => {
        for (const [id, source] of Object.entries(COMPARISON_SOURCES)) {
            expect(source.url, id).toMatch(/^https:\/\//)
        }
    })

    it('the summary names every compared extension', () => {
        for (const row of COMPARED_EXTENSIONS) {
            expect(COMPARISON_SUMMARY).toContain(row.name)
        }
    })

    it('Caramel is the only row that publishes its source code', () => {
        const published = COMPARED_EXTENSIONS.filter(row =>
            row.sourceCode.startsWith('Published'),
        )
        expect(published.map(row => row.name)).toEqual(['Caramel'])
    })
})

describe('/compare/coupon-extensions page', () => {
    it('renders one row header per extension with numbered source links that resolve', () => {
        const { container } = mount()
        const rowHeaders = Array.from(
            container.querySelectorAll('tbody th[scope="row"]'),
        )
        expect(rowHeaders).toHaveLength(COMPARED_EXTENSIONS.length)
        COMPARED_EXTENSIONS.forEach((row, index) => {
            expect(rowHeaders[index].textContent).toContain(row.name)
        })

        const order = comparisonSourceOrder()
        const sourceItems = container.querySelectorAll('li[id^="source-"]')
        expect(sourceItems).toHaveLength(order.length)
        order.forEach((id, index) => {
            const item = container.querySelector(`#source-${index + 1}`)
            expect(item?.querySelector('a')?.getAttribute('href')).toBe(
                COMPARISON_SOURCES[id].url,
            )
        })
        for (const ref of Array.from(
            container.querySelectorAll('a[href^="#source-"]'),
        )) {
            const target = ref.getAttribute('href')!.slice(1)
            expect(container.querySelector(`#${target}`), target).toBeTruthy()
        }
    })

    it('the FAQPage JSON-LD is exactly the visible FAQ', () => {
        const { container } = mount()
        const scripts = Array.from(
            container.querySelectorAll('script[type="application/ld+json"]'),
        ).map(script => JSON.parse(script.textContent || '') as unknown)
        expect(scripts).toContainEqual(faqPageJsonLd(COMPARISON_FAQ))

        const questions = Array.from(container.querySelectorAll('h3')).map(
            h3 => h3.textContent,
        )
        expect(questions).toEqual(COMPARISON_FAQ.map(item => item.question))
        for (const item of COMPARISON_FAQ) {
            expect(screen.getByText(item.answer)).toBeTruthy()
        }
        for (const pick of COMPARISON_PICKS) {
            expect(screen.getByText(pick.answer)).toBeTruthy()
        }
    })

    it('has one h1 and reports install clicks under its own placement', async () => {
        const { container } = mount()
        expect(container.querySelectorAll('h1')).toHaveLength(1)

        await waitFor(() =>
            expect(
                container.querySelector('[data-surface="web"]'),
            ).toBeTruthy(),
        )
        fireEvent.click(screen.getByText('Add to Chrome'))
        expect(trackMock).toHaveBeenCalledWith(
            'install_cta_click',
            expect.objectContaining({ placement: 'compare_extensions' }),
        )
    })

    it('shows no install callout once the extension is installed', async () => {
        document.documentElement.setAttribute(
            EXTENSION_STAMP_ATTRIBUTE,
            '1.4.1',
        )
        const { container } = mount()
        await waitFor(() =>
            expect(container.querySelector('[data-growth="install"]')).toBe(
                null,
            ),
        )
    })
})

describe('the comparison in the answer-engine text files', () => {
    it('llms-full.txt carries the summary, every row and every FAQ answer', async () => {
        const body = await getLlmsFull().text()
        expect(body).toContain('## Coupon extensions compared')
        expect(body).toContain(COMPARISON_SUMMARY)
        for (const row of COMPARED_EXTENSIONS) {
            expect(body).toContain(`- ${row.name} (${row.maker}).`)
        }
        for (const item of COMPARISON_FAQ) {
            expect(body).toContain(`### ${item.question}\n\n${item.answer}`)
        }
        for (const source of Object.values(COMPARISON_SOURCES)) {
            expect(body).toContain(source.url)
        }
    })

    it('llms.txt lists the page', async () => {
        const body = await getLlms().text()
        expect(body).toContain(`${COMPARISON_PATH})`)
    })
})
