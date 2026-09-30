import RecentlyWorkedCouponsStrip from '@/components/RecentlyWorkedCouponsStrip'
import type { RecentlyWorkedCoupon } from '@/lib/recentlyWorkedCoupons'
import { readRecentlyWorkedCoupons } from '@/lib/recentlyWorkedCouponsCache'
import * as Sentry from '@sentry/nextjs'
import { PHASE_PRODUCTION_BUILD } from 'next/constants'

// The landing page's "Codes that just worked" section, server-rendered.
//
// It used to be fetched in the browser after hydration, which kept `/` a
// purely static page but left its tiles, and the /coupons/<store> links in
// them, out of the HTML crawlers read. The landing is the site's strongest
// page (it takes nearly all organic clicks) and linked to no store page at
// all, while the store pages rank p5-10 for head terms with almost no clicks.
// Now `/` is an ISR page (page.tsx `revalidate`): the served HTML is still a
// cached copy, regenerated in the background at most once per window, so this
// read runs at most once a minute however busy the page is.
//
// Build time: the production image builds against an unreachable placeholder
// DATABASE_URL (Dockerfile `.invalid` builder env, DESIGN.md §2(m)), and `/`
// is prerendered during `next build`. That prerender renders no section; the
// first regeneration after deploy (the first request once the window has
// passed) fills it in.
//
// Runtime failure: the section is left out and the error goes to Sentry. A
// below-the-fold strip must never take the landing page down with it.
export default async function RecentlyWorkedSection() {
    if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) return null

    let read: { coupons: RecentlyWorkedCoupon[]; readAt: number }
    try {
        read = await readWithTimestamp()
    } catch (error) {
        Sentry.captureException(error, {
            tags: { area: 'landing.recently-worked' },
        })
        return null
    }
    return (
        <RecentlyWorkedCouponsStrip
            coupons={read.coupons}
            renderedAt={read.readAt}
        />
    )
}

// The clock the ISR copy was rendered against: the strip first renders with
// it (so hydration matches the server HTML), then re-judges the 24h window
// against the visitor's clock.
async function readWithTimestamp() {
    const coupons = await readRecentlyWorkedCoupons()
    return { coupons, readAt: Date.now() }
}
