/**
 * The shipped version has ONE home: package.json. WXT stamps it into every
 * generated manifest, so the old three-files-disagreeing failure mode
 * (2026-08-04: manifests frozen at 1.1.0 for 253 commits while package.json
 * said 1.0.2) is structurally gone — what is left to pin is that the one
 * source holds a value the stores will accept.
 *
 * These pins do not police WHICH version is correct — that is a release
 * decision — only that it is a store-acceptable "x.y.z" ahead of what the
 * stores already hold.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

describe('shipped version (package.json, the single source WXT stamps)', () => {
    it('is a plain x.y.z the stores will accept', () => {
        // Chrome allows 1-4 dot-separated integers, each 0-65535, no pre-release
        // suffix — "1.2.0-beta" is rejected at upload, not at review.
        expect(PKG.version).toMatch(/^\d+(\.\d+){1,3}$/)
        for (const part of PKG.version.split('.')) {
            expect(Number(part)).toBeLessThanOrEqual(65535)
        }
    })

    it('is ahead of the 1.1.0 that was already claimed by main', () => {
        // Guards the specific trap that was live: shipping the same string the
        // store already has fails the upload rather than the review.
        const [maj, min, patch] = PKG.version.split('.').map(Number)
        const rank = maj * 1e6 + min * 1e3 + (patch || 0)
        expect(rank).toBeGreaterThan(1 * 1e6 + 1 * 1e3 + 0)
    })
})
