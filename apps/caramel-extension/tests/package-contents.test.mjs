/**
 * The packaged extension must contain everything it references, and nothing
 * else.
 *
 * scripts/build-dist.mjs ships an explicit allowlist, which is only safe if
 * omitting a file is loud. These derive the requirement from the manifests and
 * index.html themselves — add a content script, an icon size, or an asset and
 * forget the build list, and this goes red long before a release does.
 *
 * The blacklist half matters for a different reason: the old rsync build put
 * package.json, the lint/knip/size configs, this tests directory and the whole
 * scripts directory into the store package.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GENERATED, NEVER_SHIP, SHIPPED } from '../scripts/build-dist.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = name => readFileSync(join(root, name), 'utf8')
const readJson = name => JSON.parse(read(name))

const CHROME = readJson('manifest.json')
const INDEX = read('index.html')
// Two ways into the package: copied from the allowlist, or written by the
// build (the environment stamp). Both count as "packaged" — what this suite
// asserts is that nothing the extension loads is missing from the result.
const packaged = [...SHIPPED, ...GENERATED]
const shipped = new Set(packaged)

/** A path ships if it is listed, or lives under a listed directory. */
const ships = p =>
    shipped.has(p) || packaged.some(entry => p.startsWith(entry + '/'))

describe('packaged extension contents', () => {
    it('ships every file the chrome manifest loads', () => {
        const cs = CHROME.content_scripts[0]
        for (const file of [
            ...cs.js,
            ...(cs.css ?? []),
            CHROME.background.service_worker,
        ]) {
            expect(ships(file), `${file} is loaded but never packaged`).toBe(
                true,
            )
        }
    })

    it('ships every icon the manifest names', () => {
        const icons = [
            ...Object.values(CHROME.icons),
            ...Object.values(CHROME.action.default_icon),
        ]
        for (const icon of icons) {
            // manifest icon paths are root-absolute ("/icons/16.png")
            const rel = icon.replace(/^\//, '')
            expect(ships(rel), `${icon} is declared but never packaged`).toBe(
                true,
            )
        }
    })

    it('ships every script and stylesheet the popup page loads', () => {
        const refs = [...INDEX.matchAll(/(?:src|href)="([^"]+)"/g)].map(
            m => m[1],
        )
        for (const ref of refs) {
            if (/^(https?:)?\/\//.test(ref)) continue // external link
            expect(
                ships(ref),
                `index.html loads ${ref}, which is not packaged`,
            ).toBe(true)
        }
    })

    it('ships every asset the packaged code reaches for at runtime', () => {
        // The popup and the shadow-root UI build asset URLs as string
        // literals, so unreferenced brand art can be dropped from the package
        // safely — but only if a reference that DOES exist is caught here.
        const sources = SHIPPED.filter(f => /\.(js|css|html)$/.test(f))
        for (const file of sources) {
            for (const [, asset] of read(file).matchAll(
                /["'`](assets\/[A-Za-z0-9._-]+\.[a-z0-9]+)["'`]/g,
            )) {
                expect(
                    ships(asset),
                    `${file} references ${asset}, which is not packaged`,
                ).toBe(true)
            }
        }
    })

    it('every allowlisted path actually exists', () => {
        for (const entry of SHIPPED) {
            expect(existsSync(join(root, entry)), `${entry} is missing`).toBe(
                true,
            )
        }
    })

    it('never packages tooling, tests or repo metadata', () => {
        for (const entry of NEVER_SHIP) {
            expect(ships(entry), `${entry} must not reach the store`).toBe(
                false,
            )
        }
    })
})
