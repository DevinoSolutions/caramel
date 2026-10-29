// @vitest-environment jsdom
import DocsPage, { metadata } from '@/app/(marketing)/docs/page'
import { GET as getLlmsFull } from '@/app/llms-full.txt/route'
import { GET as getLlms } from '@/app/llms.txt/route'
import { GET as getMarkdownTwin } from '@/app/md/[...path]/route'
import {
    CHROME_WEB_STORE_URL,
    EDGE_ADDONS_URL,
    FIREFOX_ADDONS_URL,
    SAFARI_APP_STORE_URL,
} from '@/lib/brandLinks'
import {
    DOCS_PAGE_COPY,
    DOCS_PATH,
    DOCS_SECTIONS,
    absoluteDocsHref,
    isExternalDocsLink,
} from '@/lib/marketing/docsContent'
import { markdownText } from '@/lib/seo/markdownTwins/content'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

// /docs (T-7855): the documentation hub. Pins the contract the fleet probe
// and e2e/docs-hub.spec.ts rely on: one H1, the canonical URL, every section
// reachable, the install links the brand module owns, the support promise the
// /support page makes, and a Markdown twin that carries the same copy with
// absolute links.

afterEach(cleanup)

async function twinText(): Promise<string> {
    const res = await getMarkdownTwin(
        new Request('https://grabcaramel.com/docs.md'),
        { params: Promise.resolve({ path: ['docs'] }) },
    )
    expect(res.status).toBe(200)
    return res.text()
}

describe('docs hub content', () => {
    it('has unique section ids and unique link targets per section', () => {
        const ids = DOCS_SECTIONS.map(section => section.id)
        expect(new Set(ids).size).toBe(ids.length)
        for (const section of DOCS_SECTIONS) {
            const hrefs = section.links.map(link => link.href)
            expect(new Set(hrefs).size, section.id).toBe(hrefs.length)
        }
    })

    it('covers every section the hub promises', () => {
        expect(DOCS_SECTIONS.map(section => section.id)).toEqual([
            'what-is-caramel',
            'install',
            'how-codes-are-found-and-tested',
            'supported-stores',
            'ai-agents',
            'privacy-and-data',
            'support',
            'machine-readable-resources',
        ])
    })

    it('links the four store listings from the brand module', () => {
        const install = DOCS_SECTIONS.find(section => section.id === 'install')
        const hrefs = install?.links.map(link => link.href)
        expect(hrefs).toEqual(
            expect.arrayContaining([
                CHROME_WEB_STORE_URL,
                FIREFOX_ADDONS_URL,
                EDGE_ADDONS_URL,
                SAFARI_APP_STORE_URL,
            ]),
        )
    })

    it('repeats the /support reply promise and links the pages the hub hands off to', () => {
        const all = JSON.stringify(DOCS_SECTIONS)
        expect(all).toContain('a human replies within 1 business day')
        for (const path of [
            '/faq',
            '/supported-stores',
            '/agent-setup',
            '/privacy',
            '/support',
            '/llms.txt',
            '/llms-full.txt',
            '/.well-known/security.txt',
        ]) {
            expect(
                DOCS_SECTIONS.some(section =>
                    section.links.some(link => link.href === path),
                ),
                path,
            ).toBe(true)
        }
    })

    it('absoluteDocsHref prefixes site paths and leaves absolute URLs alone', () => {
        expect(isExternalDocsLink('https://example.com/a')).toBe(true)
        expect(isExternalDocsLink('/faq')).toBe(false)
        expect(absoluteDocsHref('/faq', 'https://grabcaramel.com')).toBe(
            'https://grabcaramel.com/faq',
        )
        expect(
            absoluteDocsHref(
                'https://example.com/a',
                'https://grabcaramel.com',
            ),
        ).toBe('https://example.com/a')
    })
})

describe('/docs page', () => {
    it('declares the canonical https://grabcaramel.com/docs and the shared copy', () => {
        expect(metadata.alternates?.canonical).toBe(
            'https://grabcaramel.com/docs',
        )
        expect(metadata.title).toBe(DOCS_PAGE_COPY.title)
        expect(metadata.description).toBe(DOCS_PAGE_COPY.description)
        expect(DOCS_PAGE_COPY.description.length).toBeLessThanOrEqual(220)
    })

    it('renders exactly one H1 and one H2 per section, with every paragraph and link', () => {
        render(<DocsPage />)
        const h1s = screen.getAllByRole('heading', { level: 1 })
        expect(h1s).toHaveLength(1)
        expect(h1s[0].textContent).toBe('Caramel documentation')
        expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(
            DOCS_SECTIONS.length,
        )
        for (const section of DOCS_SECTIONS) {
            const region = screen.getByRole('region', { name: section.heading })
            for (const paragraph of section.paragraphs) {
                expect(within(region).getByText(paragraph)).toBeTruthy()
            }
            for (const link of section.links) {
                const anchor = within(region).getByRole('link', {
                    name: link.label,
                })
                expect(anchor.getAttribute('href')).toBe(link.href)
            }
        }
    })

    it('opens store listings in a new tab safely and keeps site links in the tab', () => {
        render(<DocsPage />)
        const chrome = screen.getByRole('link', { name: 'Chrome' })
        expect(chrome.getAttribute('target')).toBe('_blank')
        expect(chrome.getAttribute('rel')).toBe('noopener noreferrer')
        expect(
            screen.getByRole('link', { name: 'FAQ' }).getAttribute('target'),
        ).toBeNull()
    })
})

describe('/docs Markdown twin and llms documents', () => {
    it('serves the same sections with absolute links only', async () => {
        const text = await twinText()
        expect(
            text.startsWith('[Canonical HTML](https://grabcaramel.com/docs)'),
        ).toBe(true)
        expect(text).toMatch(/^# Caramel documentation$/m)
        for (const section of DOCS_SECTIONS) {
            expect(text).toContain(`## ${markdownText(section.heading)}`)
        }
        expect(text).toContain('[Chrome](' + CHROME_WEB_STORE_URL + ')')
        expect(text).toContain('[FAQ](https://grabcaramel.com/faq)')
        expect(text).toContain('1. You shop normally')
        expect(text).not.toMatch(/\]\(\//)
    })

    it('llms.txt and llms-full.txt list the docs hub', async () => {
        const link = `[Docs](https://grabcaramel.com${DOCS_PATH})`
        expect(await getLlms().text()).toContain(link)
        expect(getLlmsFull().headers.get('content-type')).toContain(
            'text/plain',
        )
        expect(await getLlmsFull().text()).toContain(link)
    })
})
