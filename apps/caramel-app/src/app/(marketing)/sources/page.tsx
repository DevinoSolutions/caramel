import { listActiveSources } from '@/lib/couponsRepo'
import { BASE_URL } from '@/lib/env.client'
import { toSourceMetrics } from '@/lib/sourceMetrics'
import type { Metadata } from 'next'
import SourcesPageClient from './SourcesPageClient'

// This page reads the coupon catalog from Postgres, and the production image
// builds against a deliberately unreachable placeholder DATABASE_URL (see the
// Dockerfile's `.invalid` builder env) — so it must be rendered per-request,
// never prerendered at build time (same pattern as app/sitemap.ts).
export const dynamic = 'force-dynamic'

const title = 'Where Caramel Coupon Codes Come From | Sources'
const description =
    "Where Caramel's coupon codes come from: the sources feeding the catalog, with the code count and success rate of each one as it is published — or request a new source."
const base = BASE_URL
const canonicalUrl = `${base}/sources`
const banner = `${base}/caramel_banner.png`

export const metadata: Metadata = {
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

export default async function SourcesPage() {
    // SEO: fetch the initial table server-side (same read + mapper as
    // /api/sources) so crawlers get the populated HTML instead of the old
    // client-fetch "Loading..." shell. The client keeps refetching through
    // the API after a source submission.
    const initialSources = toSourceMetrics(await listActiveSources())
    return <SourcesPageClient initialSources={initialSources} />
}
