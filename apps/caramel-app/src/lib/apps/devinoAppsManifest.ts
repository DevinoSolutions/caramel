// src/lib/apps/devinoAppsManifest.ts
//
// The shared Devino cross-app promotion manifest (fleet growth-prompts spec
// §D), vendored and validated.
//
// WHERE IT COMES FROM. `devino-landing-page` owns the list in `data/apps.ts`
// and publishes it at https://devino.ca/devino-apps.json; every Devino app
// vendors that body. Caramel VENDORS it as `./devino-apps.json` — a byte
// copy of the producer's output plus a `_vendored` provenance block — the
// same way uNotes does (`src/lib/apps/devinoAppsManifest.ts` there). Vendored
// rather than fetched because /apps is prerendered and a network read at
// build time would make `next build` depend on devino.ca being up; the list
// changes when a store listing moves, which is a deploy, not a live feed.
//
// WHY `zod/mini`. This module is reached from BROWSER code (the /apps page
// resolves store cards client-side to hoist the visitor's own browser), and
// classic zod is banned from the client bundle for the size reason recorded
// in src/lib/env.client.ts. The shape is the producer's contract
// (`lib/contracts/devino-apps.ts`, zod 4 classic) field for field; keep the
// two in step by hand when the producer adds a field, and re-vendor in the
// same commit. `tests/unit/devino-apps-manifest.test.ts` pins the vendored
// body against this schema.
//
// NO SILENT FALLBACK. The manifest is parsed once at module load and a
// malformed body throws, which fails `next build` rather than shipping an
// /apps page with missing or wrong store links.
//
// COMING SOON IS EXPRESSED BY ABSENCE. The producer lists a store only once
// the listing is live, so a store type missing from an app's `stores` array
// is the manifest saying NOT LISTED YET, and the consumer renders a greyed,
// non-clickable "Coming soon" badge for it (owner ruling, Amin 2026-09-18).
// `storeUrl()` returning `null` is that signal.
import * as z from 'zod/mini'

import rawManifest from './devino-apps.json'

/** The demographic buckets apps match on. Fixed vocabulary — spec §D. */
export const APP_AUDIENCES = [
    'students',
    'freelancers',
    'founders',
    'marketers',
    'developers',
    'ops',
] as const

/**
 * Store types the producer knows. Safari extensions are distributed through
 * Apple's App Store, which the producer models as `macos` (Mac App Store) —
 * there is no `safari` type, so Caramel's Safari listing rides on `macos`.
 */
export const STORE_TYPES = [
    'ios',
    'android',
    'macos',
    'windows',
    'chrome',
    'firefox',
    'edge',
] as const

export type DevinoAudience = (typeof APP_AUDIENCES)[number]
export type DevinoStoreType = (typeof STORE_TYPES)[number]

const httpsUrl = z
    .url()
    .check(z.refine(url => url.startsWith('https://'), 'must be an https URL'))

const storeLinkSchema = z.object({
    type: z.enum(STORE_TYPES),
    /** Clean listing URL — no campaign params; consumers add their own. */
    url: httpsUrl,
})

export const devinoAppSchema = z.object({
    /** Stable machine id — never renamed once published (consumers key on it). */
    id: z
        .string()
        .check(
            z.regex(
                /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
                'lowercase slug, hyphens only',
            ),
        ),
    name: z.string().check(z.minLength(1), z.maxLength(40)),
    tagline: z.string().check(z.minLength(1), z.maxLength(160)),
    /** Canonical product URL. */
    url: httpsUrl,
    /** Absolute icon URL, square PNG, served from devino.ca. */
    icon: httpsUrl,
    stores: z._default(z.array(storeLinkSchema), []),
    audiences: z.array(z.enum(APP_AUDIENCES)).check(z.minLength(1)),
    /** Ships an MCP server (spec §C "use with your AI tools"). */
    mcp: z._default(z.boolean(), false),
})

export const devinoAppsManifestSchema = z.object({
    schemaVersion: z.literal(1),
    /** Where humans can browse the same list. */
    directory: httpsUrl,
    apps: z.array(devinoAppSchema).check(z.minLength(1)),
})

export type DevinoApp = z.infer<typeof devinoAppSchema>
export type DevinoAppsManifest = z.infer<typeof devinoAppsManifestSchema>

/**
 * Parse a manifest body, throwing with every issue named. Duplicate ids are
 * rejected here rather than in the schema because consumers key on `id`: two
 * entries for one id would make "which app is this" depend on array order.
 */
export function parseDevinoAppsManifest(input: unknown): DevinoAppsManifest {
    const result = devinoAppsManifestSchema.safeParse(input)
    if (!result.success) {
        throw new Error(
            `devino-apps.json is malformed: ${result.error.message}`,
        )
    }
    const seen = new Set<string>()
    for (const app of result.data.apps) {
        if (seen.has(app.id)) {
            throw new Error(
                `devino-apps.json is malformed: duplicate app id "${app.id}"`,
            )
        }
        seen.add(app.id)
    }
    return result.data
}

/** Parse ONE app entry through the same contract the manifest uses. */
export function parseDevinoApp(input: unknown): DevinoApp {
    const result = devinoAppSchema.safeParse(input)
    if (!result.success) {
        throw new Error(
            `Devino app entry is malformed: ${result.error.message}`,
        )
    }
    return result.data
}

/** The vendored manifest, validated once at module load. */
export const DEVINO_APPS_MANIFEST: DevinoAppsManifest =
    parseDevinoAppsManifest(rawManifest)

/** Clean listing URL for one store, or `null` when the app is not listed there. */
export function storeUrl(app: DevinoApp, type: DevinoStoreType): string | null {
    return app.stores.find(store => store.type === type)?.url ?? null
}

/**
 * The sibling apps worth showing next to `selfId`: every OTHER app that
 * shares at least one audience, in manifest order, capped at `limit`.
 * PURE so the rule is testable against fixtures.
 */
export function crossPromotedApps(
    manifest: DevinoAppsManifest,
    options: {
        selfId: string
        audiences: readonly DevinoAudience[]
        limit: number
    },
): DevinoApp[] {
    const wanted = new Set<DevinoAudience>(options.audiences)
    return manifest.apps
        .filter(app => app.id !== options.selfId)
        .filter(app => app.audiences.some(audience => wanted.has(audience)))
        .slice(0, options.limit)
}
