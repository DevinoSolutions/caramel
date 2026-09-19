import SourcesPage, { generateMetadata } from '@/app/(marketing)/sources/page'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Pins (marketing)/sources/page.tsx's indexability: the table is server-
// rendered from listActiveSources, and with ZERO active sources the page is an
// empty shell (prod on 2026-09-11: `/api/sources` → [], GSC "crawled, not
// indexed"), so generateMetadata must noindex it — while keeping every other
// piece of the static metadata (title, canonical, OG) intact. The catalog read
// is mocked at the couponsRepo boundary; the client component is stubbed so
// importing the page doesn't drag the 'use client' tree into a node run.

const { repoMock } = vi.hoisted(() => ({
    repoMock: { listActiveSources: vi.fn() },
}))
vi.mock('@/lib/couponsRepo', () => repoMock)
vi.mock('@/app/(marketing)/sources/SourcesPageClient', () => ({
    default: () => null,
}))

const ACTIVE_SOURCE = {
    id: 'src-1',
    source: 'Caramel Sample Feed A',
    websites: ['ebay.com'],
    status: 'ACTIVE',
    total_coupons: 12,
    total_used: 3,
    total_expired: 1,
}

beforeEach(() => {
    repoMock.listActiveSources.mockReset()
})

describe('SourcesPage generateMetadata — empty-table noindex', () => {
    it('with zero ACTIVE sources → robots noindex,follow; title/canonical/OG unchanged', async () => {
        repoMock.listActiveSources.mockResolvedValue([])

        const metadata = await generateMetadata()

        expect(metadata.robots).toEqual({ index: false, follow: true })
        expect(metadata.title).toBe(
            'Where Caramel Coupon Codes Come From | Sources',
        )
        expect(metadata.alternates?.canonical).toBe('/sources')
        expect(metadata.openGraph?.title).toBe(
            'Where Caramel Coupon Codes Come From | Sources',
        )
    })

    it('with at least one ACTIVE source → indexable (no robots override)', async () => {
        repoMock.listActiveSources.mockResolvedValue([ACTIVE_SOURCE])

        const metadata = await generateMetadata()

        expect(metadata.robots).toBeUndefined()
        expect(metadata.alternates?.canonical).toBe('/sources')
    })
})

describe('SourcesPage body', () => {
    it('server-renders the client table with the mapped source metrics from the same read', async () => {
        repoMock.listActiveSources.mockResolvedValue([ACTIVE_SOURCE])

        const el = (await SourcesPage()) as ReactElement<{
            initialSources: Array<Record<string, unknown>>
        }>

        expect(el.props.initialSources).toHaveLength(1)
        expect(el.props.initialSources[0]).toMatchObject({
            id: 'src-1',
            source: 'Caramel Sample Feed A',
        })
    })
})
