import { CARAMEL_APP } from '@/lib/apps/caramelApp'
import {
    DEVINO_APPS_MANIFEST,
    crossPromotedApps,
    parseDevinoAppsManifest,
    storeUrl,
    type DevinoAppsManifest,
} from '@/lib/apps/devinoAppsManifest'
import {
    CHROME_WEB_STORE_URL,
    EDGE_ADDONS_URL,
    FIREFOX_ADDONS_URL,
    SAFARI_APP_STORE_URL,
} from '@/lib/brandLinks'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// The vendored copy of the shared Devino manifest (fleet spec §D) and
// Caramel's own entry, both through the ONE zod/mini contract the app boots
// through. A malformed body must fail here (and `next build`), never ship as
// a page with wrong store links.

const VENDORED_PATH = path.resolve(
    __dirname,
    '../../src/lib/apps/devino-apps.json',
)

const fixture = (apps: DevinoAppsManifest['apps']): DevinoAppsManifest => ({
    schemaVersion: 1,
    directory: 'https://devino.ca/apps',
    apps,
})

const app = (
    id: string,
    audiences: DevinoAppsManifest['apps'][number]['audiences'],
    stores: DevinoAppsManifest['apps'][number]['stores'] = [],
): DevinoAppsManifest['apps'][number] => ({
    id,
    name: id,
    tagline: `${id} tagline`,
    url: `https://${id}.example`,
    icon: `https://devino.ca/app-icons/${id}.png`,
    stores,
    audiences,
    mcp: false,
})

describe('devino-apps.json (vendored)', () => {
    it('parses through the shared contract with a provenance block the app never reads', () => {
        const raw = JSON.parse(fs.readFileSync(VENDORED_PATH, 'utf8'))
        expect(raw._vendored.source).toBe('https://devino.ca/devino-apps.json')
        expect(raw._vendored.vendoredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        const parsed = parseDevinoAppsManifest(raw)
        expect(parsed).toEqual(DEVINO_APPS_MANIFEST)
        expect('_vendored' in parsed).toBe(false)
        expect(parsed.apps.length).toBeGreaterThanOrEqual(10)
    })

    it('rejects a malformed body loudly (bad store type, duplicate id, http URL)', () => {
        expect(() =>
            parseDevinoAppsManifest(
                fixture([
                    app(
                        'a',
                        ['students'],
                        [{ type: 'safari' as never, url: 'https://x.example' }],
                    ),
                ]),
            ),
        ).toThrow(/malformed/)
        expect(() =>
            parseDevinoAppsManifest(
                fixture([app('a', ['students']), app('a', ['ops'])]),
            ),
        ).toThrow(/duplicate app id "a"/)
        expect(() =>
            parseDevinoAppsManifest(
                fixture([
                    { ...app('a', ['students']), url: 'http://a.example' },
                ]),
            ),
        ).toThrow(/https/)
    })
})

describe('CARAMEL_APP (local entry until the producer lists Caramel)', () => {
    it('is not in the producer manifest yet — the TODO in caramelApp.ts stands', () => {
        // When this starts failing, the producer has added Caramel: replace
        // the literal with a manifest lookup (see the header comment there).
        expect(
            DEVINO_APPS_MANIFEST.apps.find(entry => entry.id === 'caramel'),
        ).toBeUndefined()
    })

    it('carries the four canonical listings from brandLinks.ts, Safari as macos', () => {
        expect(storeUrl(CARAMEL_APP, 'chrome')).toBe(CHROME_WEB_STORE_URL)
        expect(storeUrl(CARAMEL_APP, 'firefox')).toBe(FIREFOX_ADDONS_URL)
        expect(storeUrl(CARAMEL_APP, 'edge')).toBe(EDGE_ADDONS_URL)
        expect(storeUrl(CARAMEL_APP, 'macos')).toBe(SAFARI_APP_STORE_URL)
        expect(storeUrl(CARAMEL_APP, 'android')).toBeNull()
        expect(CARAMEL_APP.mcp).toBe(false)
    })
})

describe('crossPromotedApps', () => {
    it('excludes self, requires a shared audience, keeps manifest order and caps', () => {
        const manifest = fixture([
            app('self', ['students']),
            app('no-overlap', ['ops']),
            app('one', ['students', 'ops']),
            app('two', ['students']),
            app('three', ['students']),
            app('four', ['students']),
        ])
        const picked = crossPromotedApps(manifest, {
            selfId: 'self',
            audiences: ['students'],
            limit: 3,
        }).map(entry => entry.id)
        expect(picked).toEqual(['one', 'two', 'three'])
    })

    it('resolves Caramel to real sibling apps from the vendored manifest', () => {
        const picked = crossPromotedApps(DEVINO_APPS_MANIFEST, {
            selfId: CARAMEL_APP.id,
            audiences: CARAMEL_APP.audiences,
            limit: 3,
        })
        expect(picked.length).toBe(3)
        for (const entry of picked) {
            expect(entry.id).not.toBe('caramel')
            expect(entry.url.startsWith('https://')).toBe(true)
        }
    })
})
