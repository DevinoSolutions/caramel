import { listActiveSources } from '@/lib/couponsRepo'
import { BASE_URL } from '@/lib/env.client'
import { toSourceMetrics } from '@/lib/sourceMetrics'
import type { Metadata } from 'next'
import { cache } from 'react'
import SourcesPageClient from './SourcesPageClient'

// This page reads the coupon catalog from Postgres, and the production image
// builds against a deliberately unreachable placeholder DATABASE_URL (see the
// Dockerfile's `.invalid` builder env) — so it must be rendered per-request,
// never prerendered at build time (same pattern as app/sitemap.ts).
export const dynamic = 'force-dynamic'

const title = 'Where Caramel Coupon Codes Come From | Sources'
const description =
    'See every source Caramel pulls coupon codes from, how many codes each one contributes, and its success rate — or request a new source.'
const base = BASE_URL
const canonicalUrl = `${base}/sources`
const banner = `${base}/caramel_banner.png`

const baseMetadata: Metadata = {
    title,
    description,
    alternates: {
        canonical: '/sources',
    },
    openGraph: {
        type: 'website',
        url: canonicalUrl,
        title,
        description,
        locale: 'en_US',
        siteName: 'Caramel',
        images: [
            {
                url: banner,
                width: 1200,
                height: 630,
                alt: "Caramel's coupon sources",
            },
        ],
    },
    twitter: {
        card: 'summary_large_image',
        site: '@CaramelOfficial',
        title,
        description,
        images: [banner],
    },
}

// cache(): generateMetadata needs the active-source list too (for the
// empty-table noindex below), and React request-level caching makes that share
// ONE catalog read with the page body — same pattern as the store page's
// fetchStoreCoupons.
const fetchActiveSources = cache(async () => listActiveSources())

export async function generateMetadata(): Promise<Metadata> {
    // With zero ACTIVE sources the page is an empty shell (prod had 0 on
    // 2026-09-11 and GSC reported it crawled-not-indexed). Keep it reachable
    // and followed, but out of the index until there is a table to index; the
    // sitemap (app/sitemap.ts) lists /sources under the same condition.
    const sources = await fetchActiveSources()
    return {
        ...baseMetadata,
        robots: sources.length > 0 ? undefined : { index: false, follow: true },
    }
}

export default async function SourcesPage() {
    // SEO: fetch the initial table server-side (same read + mapper as
    // /api/sources) so crawlers get the populated HTML instead of the old
    // client-fetch "Loading..." shell. The client keeps refetching through
    // the API after a source submission.
    const initialSources = toSourceMetrics(await fetchActiveSources())
    return <SourcesPageClient initialSources={initialSources} />
}
