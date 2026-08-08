/**
 * The two manifests must inject the SAME code.
 *
 * They had silently diverged: `manifest-firefox.json` was still listing the
 * eight hard-coded store domains from before the catalog went config-driven
 * (2670 stores as of 2026-08-04), was missing `cart-signals.js` entirely — the
 * file Chrome loads FIRST, which the cart classifier reads through
 * `window.CaramelCartSignals` — and injected no `caramel-content.css` at all.
 * Nothing failed, because no CI job builds the Firefox variant; the drift just
 * sat there waiting for whoever loaded it to debug a half-wired extension.
 *
 * These pins do not say the two manifests must be identical — Firefox
 * legitimately differs on background type and the `identity` permission. They
 * say the two must AGREE about what gets injected into a page, which is the
 * part that silently rots.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = name => JSON.parse(readFileSync(join(root, name), 'utf8'))

const CHROME = read('manifest.json')
const FIREFOX = read('manifest-firefox.json')

const contentScripts = m => m.content_scripts?.[0] ?? {}

describe('manifest parity', () => {
    it('injects the same scripts, in the same order', () => {
        // Order is load-bearing: caramel-env.js stamps CARAMEL_ENV and
        // caramel-base.js reads it in its own top-level initializers, which
        // separate <script>-equivalent files do not hoist backward across.
        expect(contentScripts(FIREFOX).js).toEqual(contentScripts(CHROME).js)
    })

    it('gives both background contexts the environment stamp', () => {
        // Chrome/Safari run background.js as an MV3 service worker and it
        // importScripts the stamp itself; Firefox runs it as a background
        // script, where importScripts does not exist, so the manifest must
        // load the stamp first. Miss this and the Firefox worker reads
        // CARAMEL_BASE_URL as undefined — every API URL becomes "undefined/…".
        expect(FIREFOX.background.scripts).toEqual([
            'caramel-env.js',
            'background.js',
        ])
        expect(CHROME.background.service_worker).toBe('background.js')
    })

    it('injects the same stylesheets', () => {
        expect(contentScripts(FIREFOX).css ?? []).toEqual(
            contentScripts(CHROME).css ?? [],
        )
    })

    it('matches the same pages', () => {
        expect(contentScripts(FIREFOX).matches).toEqual(
            contentScripts(CHROME).matches,
        )
    })

    it('never ships a localhost/http host permission to real users', () => {
        // A packed build asking for a dev server on the user's own machine
        // widens the store install prompt and lets the released extension talk
        // to whatever is listening on that port. The local origin belongs to
        // the e2e suite, which grants it to its temp copy
        // (scripts/test-extension.mjs) — never to the shipped manifest.
        for (const m of [CHROME, FIREFOX]) {
            for (const host of m.host_permissions || []) {
                expect(host).not.toMatch(/^http:\/\//)
                expect(host).not.toContain('localhost')
                expect(host).not.toContain('127.0.0.1')
            }
        }
    })

    it('grants the same host permissions in both manifests', () => {
        expect([...(FIREFOX.host_permissions || [])].sort()).toEqual(
            [...(CHROME.host_permissions || [])].sort(),
        )
    })

    it('keeps cart-signals.js first, ahead of everything that reads it', () => {
        // coupon-fetch.js's classifyCartCategory() degrades to null when
        // window.CaramelCartSignals is absent, so dropping this file costs the
        // cart-category hint with no error anywhere — exactly how it went
        // missing from the Firefox manifest unnoticed.
        for (const m of [CHROME, FIREFOX]) {
            const js = contentScripts(m).js
            expect(js).toContain('cart-signals.js')
            expect(js.indexOf('cart-signals.js')).toBeLessThan(
                js.indexOf('coupon-fetch.js'),
            )
        }
    })
})
