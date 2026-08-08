import SearchSection from '@/components/supported-site/search-section'
import { listTopSites } from '@/lib/couponsRepo'
import { BASE_URL } from '@/lib/env.client'
import type { Metadata } from 'next'

// This page reads the coupon catalog from Postgres, and the production image
// builds against a deliberately unreachable placeholder DATABASE_URL (see the
// Dockerfile's `.invalid` builder env) — so it must be rendered per-request,
// never prerendered at build time (same pattern as app/sitemap.ts).
export const dynamic = 'force-dynamic'

const title = 'Caramel | Supported Stores'
const description =
    'Explore the stores supported by Caramel and start saving with our coupon extension.'
const canonicalUrl = 'https://grabcaramel.com/supported-stores'
const base = BASE_URL
const banner = `${base}/caramel_banner.png`

export const metadata: Metadata = {
    title,
    description,
    alternates: {
        canonical: canonicalUrl,
    },
    openGraph: {
        type: 'website',
        url: canonicalUrl,
        title,
        description,
        locale: 'en_US',
        images: [
            {
                url: banner,
                width: 1200,
                height: 630,
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

export default async function SupportedSitesPage() {
    // SEO: fetch the "Top Supported Websites" grid server-side (same read the
    // /api/sites/top-sites route uses) so crawlers see actual store names in
    // the HTML instead of the old client-fetch empty shell. The nullable-site
    // filter mirrors app/sitemap.ts — a null GROUP BY site is possible in the
    // row shape and unrenderable here.
    const topSiteRows = await listTopSites()
    const initialTopSites = topSiteRows
        .map(row => row.site)
        .filter((site): site is string => Boolean(site && site.trim()))
    return (
        <main className="flex min-h-screen flex-col items-center px-6 pt-32 dark:bg-darkBg">
            <SearchSection initialTopSites={initialTopSites} />
        </main>
    )
}
