/**
 * The shipped version lives in three files and a release depends on all three.
 *
 * `release-extension.yml` fires on a merge into `main` and uploads whatever
 * `manifest.json` says to the Chrome Web Store, which REJECTS any upload whose
 * version does not increment. On 2026-08-04 that version had not moved since
 * 2025-07-14 — 253 commits and 93 changed extension files later, `dev` and
 * `main` both still claimed 1.1.0, so the release would have been rejected on
 * upload with the work sitting behind it. `package.json` had meanwhile drifted
 * to its own number (1.0.2), so nothing in the repo agreed on what ships.
 *
 * These pins do not police WHICH version is correct — that is a release
 * decision — only that the three files cannot disagree, and that the version
 * is a store-acceptable "x.y.z".
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = name => JSON.parse(readFileSync(join(root, name), 'utf8'))

const CHROME = read('manifest.json')
const FIREFOX = read('manifest-firefox.json')
const PKG = read('package.json')

describe('shipped version', () => {
    it('is identical in both manifests', () => {
        expect(FIREFOX.version, 'firefox manifest drifted from chrome').toBe(
            CHROME.version,
        )
    })

    it('matches package.json', () => {
        expect(
            PKG.version,
            'package.json drifted from the shipped manifest',
        ).toBe(CHROME.version)
    })

    it('is a plain x.y.z the stores will accept', () => {
        // Chrome allows 1-4 dot-separated integers, each 0-65535, no pre-release
        // suffix — "1.2.0-beta" is rejected at upload, not at review.
        expect(CHROME.version).toMatch(/^\d+(\.\d+){1,3}$/)
        for (const part of CHROME.version.split('.')) {
            expect(Number(part)).toBeLessThanOrEqual(65535)
        }
    })

    it('is ahead of the 1.1.0 that was already claimed by main', () => {
        // Guards the specific trap that was live: shipping the same string the
        // store already has fails the upload rather than the review.
        const [maj, min, patch] = CHROME.version.split('.').map(Number)
        const rank = maj * 1e6 + min * 1e3 + (patch || 0)
        expect(rank).toBeGreaterThan(1 * 1e6 + 1 * 1e3 + 0)
    })
})
