import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// F-014 — deps-pinned guard (rules-become-checks). The audit found every
// manifest using floating `^`/`~` ranges, which lets two installs resolve
// to different versions of the same declared dependency. This test reads
// the real tracked manifests, so it fails again the moment a future PR
// reintroduces a floating range — not just today.

const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
)

const MANIFESTS = [
    'package.json',
    'apps/caramel-app/package.json',
    'apps/caramel-extension/package.json',
]

const FLOATING_RANGE = /^[\^~]/

interface PackageManifest {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    pnpm?: { overrides?: Record<string, string> }
}

function readManifest(relPath: string): PackageManifest {
    return JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8'),
    ) as PackageManifest
}

describe('deps-pinned (F-014): no floating ^/~ ranges in any manifest', () => {
    for (const relPath of MANIFESTS) {
        const manifest = readManifest(relPath)

        for (const field of ['dependencies', 'devDependencies'] as const) {
            const decl = manifest[field] ?? {}
            const floating = Object.entries(decl).filter(([, version]) =>
                FLOATING_RANGE.test(version),
            )

            it(`${relPath}: ${field} has no floating ranges`, () => {
                expect(floating).toEqual([])
            })
        }
    }

    it('root package.json: pnpm.overrides has no floating ranges', () => {
        const manifest = readManifest('package.json')
        const overrides = manifest.pnpm?.overrides ?? {}
        const floating = Object.entries(overrides).filter(([, version]) =>
            FLOATING_RANGE.test(version),
        )
        expect(floating).toEqual([])
    })
})
