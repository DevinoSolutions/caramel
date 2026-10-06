// @vitest-environment jsdom
import HoneyExtensionPage, {
    metadata,
} from '@/app/(marketing)/honey-extension/page'
import { GET as getLlmsFull } from '@/app/llms-full.txt/route'
import { GET as getLlms } from '@/app/llms.txt/route'
import SourceRefList from '@/components/seo/SourceRefs'
import { faqPageJsonLd } from '@/lib/jsonLd'
import {
    COMPARED_EXTENSIONS,
    COMPARISON_FAQ,
    COMPARISON_SOURCES,
} from '@/lib/seo/extensionComparison'
import {
    CARAMEL_ROW,
    HONEY_GUIDE_FAQ,
    HONEY_GUIDE_PATH,
    HONEY_GUIDE_SUMMARY,
    HONEY_GUIDE_SUMMARY_SOURCES,
    HONEY_ROW,
    HONEY_VS_CARAMEL,
    honeyGuideSourceOrder,
} from '@/lib/seo/honeyExtensionGuide'
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

// /honey-extension states things about a competitor, so the rule in
// src/lib/seo/honeyExtensionGuide.ts is pinned here: it says nothing about
// Honey that /compare/coupon-extensions does not (same rows, same sources),
// every answer is footnoted to a listed source, and the FAQPage JSON-LD is
// the visible FAQ.

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))
vi.mock('@/lib/analytics/growthEvents', () => ({ trackGrowthEvent: trackMock }))

function mount() {
    return render(
        <SurfaceProvider>
            <HoneyExtensionPage />
        </SurfaceProvider>,
    )
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

describe('honeyExtensionGuide data', () => {
    it('reads its side-by-side table from the comparison rows', () => {
        expect(COMPARED_EXTENSIONS).toContain(HONEY_ROW)
        expect(COMPARED_EXTENSIONS).toContain(CARAMEL_ROW)
        const honeyValues = HONEY_VS_CARAMEL.map(row => row.honey)
        expect(honeyValues).toEqual([
            HONEY_ROW.maker,
            HONEY_ROW.price,
            HONEY_ROW.revenue,
            HONEY_ROW.rewards,
            HONEY_ROW.account,
            HONEY_ROW.browsers,
            HONEY_ROW.sourceCode,
        ])
    })

    it('every answer cites at least one comparison source', () => {
        for (const item of HONEY_GUIDE_FAQ) {
            expect(item.sources.length, item.question).toBeGreaterThan(0)
            for (const id of item.sources) {
                expect(COMPARISON_SOURCES, id).toHaveProperty(id)
            }
        }
    })

    it('a question it shares with the comparison page has the same answer', () => {
        const shared = HONEY_GUIDE_FAQ.flatMap(item => {
            const match = COMPARISON_FAQ.find(
                candidate => candidate.question === item.question,
            )
            return match ? [{ item, match }] : []
        })
        expect(shared.map(({ item }) => item.question)).toContain(
            'Is Honey still available in 2026?',
        )
        for (const { item, match } of shared) {
            expect(item.answer).toBe(match.answer)
        }
    })

    it('keeps "alternative" out of the questions (the home page owns that query)', () => {
        for (const item of HONEY_GUIDE_FAQ) {
            expect(item.question.toLowerCase()).not.toContain('alternative')
        }
    })

    it('makes no safety or wrongdoing verdict of its own (only quoted source titles may)', () => {
        const verdict = /\b(safe|unsafe|scam|illegal|steal|stole)\b/i
        const ownWords = [
            String(metadata.title),
            String(metadata.description),
            HONEY_GUIDE_SUMMARY,
            ...HONEY_GUIDE_FAQ.flatMap(item => [item.question, item.answer]),
        ]
        for (const text of ownWords) expect(text).not.toMatch(verdict)
    })

    it('footnotes the summary to listed sources', () => {
        expect(HONEY_GUIDE_SUMMARY_SOURCES.length).toBeGreaterThan(0)
        for (const id of HONEY_GUIDE_SUMMARY_SOURCES) {
            expect(COMPARISON_SOURCES, id).toHaveProperty(id)
        }
    })
})

describe('/honey-extension metadata', () => {
    it('pins the title (no "alternative", no safety verdict)', () => {
        expect(metadata.title).toBe(
            'Honey Extension in 2026: What Changed and the Controversy Explained | Caramel',
        )
    })
})

describe('SourceRefList', () => {
    it('throws when a cited source is missing from the page order', () => {
        expect(() =>
            render(<SourceRefList ids={['fortune']} order={['honeyChrome']} />),
        ).toThrow(/"fortune" is cited but missing/)
    })
})

describe('/honey-extension page', () => {
    it('has one h1 without "alternative", the summary, and numbered sources that resolve', () => {
        const { container } = mount()
        const h1s = container.querySelectorAll('h1')
        expect(h1s).toHaveLength(1)
        expect(h1s[0].textContent?.toLowerCase()).not.toContain('alternative')
        expect(container.querySelector('header')?.textContent).toContain(
            HONEY_GUIDE_SUMMARY,
        )

        const order = honeyGuideSourceOrder()
        const items = container.querySelectorAll('li[id^="source-"]')
        expect(items).toHaveLength(order.length)
        order.forEach((id, index) => {
            const item = container.querySelector(`#source-${index + 1}`)
            expect(item?.querySelector('a')?.getAttribute('href')).toBe(
                COMPARISON_SOURCES[id].url,
            )
        })
        const refs = Array.from(
            container.querySelectorAll('a[href^="#source-"]'),
        )
        expect(refs.length).toBeGreaterThan(0)
        for (const ref of refs) {
            const target = ref.getAttribute('href')!.slice(1)
            expect(container.querySelector(`#${target}`), target).toBeTruthy()
        }
        // Every listed source is cited somewhere on the page.
        const cited = new Set(refs.map(ref => ref.getAttribute('href')))
        expect(cited.size).toBe(order.length)
    })

    it('the FAQPage JSON-LD is exactly the visible FAQ', () => {
        const { container } = mount()
        const scripts = Array.from(
            container.querySelectorAll('script[type="application/ld+json"]'),
        ).map(script => JSON.parse(script.textContent || '') as unknown)
        expect(scripts).toContainEqual(faqPageJsonLd(HONEY_GUIDE_FAQ))

        const questions = Array.from(container.querySelectorAll('h3')).map(
            h3 => h3.textContent,
        )
        expect(questions).toEqual(HONEY_GUIDE_FAQ.map(item => item.question))
        for (const item of HONEY_GUIDE_FAQ) {
            expect(screen.getByText(item.answer)).toBeTruthy()
        }
    })

    it('links the home page and the comparison', () => {
        const { container } = mount()
        const hrefs = Array.from(container.querySelectorAll('a')).map(a =>
            a.getAttribute('href'),
        )
        expect(hrefs).toContain('/')
        expect(hrefs).toContain('/compare/coupon-extensions')
    })

    it('reports install clicks under its own placement', async () => {
        const { container } = mount()
        await waitFor(() =>
            expect(
                container.querySelector('[data-surface="web"]'),
            ).toBeTruthy(),
        )
        fireEvent.click(screen.getByText('Add to Chrome'))
        expect(trackMock).toHaveBeenCalledWith(
            'install_cta_click',
            expect.objectContaining({ placement: 'honey_extension' }),
        )
    })
})

describe('the Honey guide in the answer-engine text files', () => {
    it('llms-full.txt carries the summary and every answer', async () => {
        const body = await getLlmsFull().text()
        expect(body).toContain('## The Honey extension, explained')
        expect(body).toContain(HONEY_GUIDE_SUMMARY)
        for (const item of HONEY_GUIDE_FAQ) {
            expect(body).toContain(`### ${item.question}\n\n${item.answer}`)
        }
        // Its sources are the comparison's, already listed in full.
        for (const id of honeyGuideSourceOrder()) {
            expect(body).toContain(COMPARISON_SOURCES[id].url)
        }
    })

    it('llms.txt lists the page', async () => {
        const body = await getLlms().text()
        expect(body).toContain(`${HONEY_GUIDE_PATH})`)
    })
})
