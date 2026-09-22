// src/app/(marketing)/apps/crossAppPromotions.ts
//
// "More from Devino" on /apps (and the `cross_app` growth prompt), driven by
// the shared manifest (fleet spec §D). WHICH apps to show is derived: every
// app whose `audiences` intersect Caramel's, Caramel itself excluded, capped
// at three. The COPY is ours: the manifest carries a neutral tagline written
// for a directory page; a shopper on Caramel deserves the angle that matters
// to them, so blurbs are Caramel-authored overrides keyed by manifest id and
// an app without one falls back to its tagline (it still shows up).
//
// TODO(2026-09-22): route `href` through Dub (dub.devino.ca) so cross-app
// clicks are measured at the link layer as well as in PostHog — the fleet
// spec asks for it. `DUB_API_KEY` is dormant fleet-wide and a hand-written
// dub.devino.ca path would 404 today; `crossapp_click` covers the measurement
// until the short links exist.
import { CARAMEL_APP } from '@/lib/apps/caramelApp'
import {
    DEVINO_APPS_MANIFEST,
    crossPromotedApps,
    type DevinoApp,
    type DevinoAppsManifest,
} from '@/lib/apps/devinoAppsManifest'

/** The spec's "2-3 apps max". */
export const CROSS_APP_LIMIT = 3

const BLURB_OVERRIDES: Readonly<Record<string, string>> = {
    unotes: 'Past exams, notes and solutions shared by students — free, like Caramel.',
    shorty: 'Summarises the review video before you buy: YouTube, podcasts and documents in a minute.',
    getitdone:
        'Tasks, daily check-ins and time tracking in one place, for you and your AI agents.',
}

export type CrossAppPromotion = {
    /** Manifest id — also the `target_app` value on `crossapp_click`. */
    id: string
    name: string
    href: string
    /** Square PNG from devino.ca — the manifest's own icon. */
    icon: string
    blurb: string
}

/** PURE over a manifest so the audience rule is testable against fixtures. */
export function buildCrossAppPromotions(
    manifest: DevinoAppsManifest,
    self: DevinoApp = CARAMEL_APP,
): readonly CrossAppPromotion[] {
    return crossPromotedApps(manifest, {
        selfId: self.id,
        audiences: self.audiences,
        limit: CROSS_APP_LIMIT,
    }).map(app => ({
        id: app.id,
        name: app.name,
        href: app.url,
        icon: app.icon,
        blurb: BLURB_OVERRIDES[app.id] ?? app.tagline,
    }))
}

export const CROSS_APP_PROMOTIONS: readonly CrossAppPromotion[] =
    buildCrossAppPromotions(DEVINO_APPS_MANIFEST, CARAMEL_APP)
