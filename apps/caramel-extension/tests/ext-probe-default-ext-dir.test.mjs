// The probe's default extension directory must be a build it can actually load.
//
// The refusal suite next door (ext-probe-extension-required.test.mjs) pins the
// other half: a probe that cannot load an extension never produces a verdict.
// Both halves were true at once and that was the whole defect — the default
// pointed at `apps/caramel-extension`, which the WXT migration left without a
// manifest, so the gate fired correctly on every run nobody had set EXT_DIR
// for. Measured 2026-08-19: ten discovery runs in one six-hour window took no
// extension QA at all, and their configs were the best of the batch.
//
// Fake repo roots in a temp dir, never this checkout's own `.output`: that
// directory is gitignored, so a suite that asserted against it would pass on a
// developer's machine and be vacuous in CI.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    extBuildOutputs,
    extensionLoadProblem,
    legacyExtDir,
    resolveDefaultExtDir,
} from '../../../tools/ext-probe/ext-dir.mjs'

function fakeRepo() {
    return mkdtempSync(join(tmpdir(), 'ext-dir-root-'))
}

function build(
    root,
    name,
    manifest = { manifest_version: 3, version: '9.9.9' },
) {
    const dir = join(root, 'apps', 'caramel-extension', '.output', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
    return dir
}

describe('the default extension directory prefers a loadable build', () => {
    it('resolves to the production build when one exists', () => {
        const root = fakeRepo()
        const prod = build(root, 'chrome-mv3')

        expect(resolveDefaultExtDir(root)).toBe(prod)
        expect(extensionLoadProblem(resolveDefaultExtDir(root))).toBeNull()
    })

    it('prefers production over dev when both exist', () => {
        // Not cosmetic: the dev build points at dev backends and carries the
        // dev env stamp, so measuring it answers a question ext-QA never
        // asked. A developer who ran `pnpm build:dev` last must still get the
        // shopper's build by default.
        const root = fakeRepo()
        const prod = build(root, 'chrome-mv3')
        const dev = build(root, 'chrome-mv3-dev')

        expect(resolveDefaultExtDir(root)).toBe(prod)
        expect(resolveDefaultExtDir(root)).not.toBe(dev)
    })

    it('falls back to the dev build when it is the only one built', () => {
        const root = fakeRepo()
        const dev = build(root, 'chrome-mv3-dev')

        expect(resolveDefaultExtDir(root)).toBe(dev)
    })

    it('skips a build Chromium could not load and takes the next one', () => {
        // The default is chosen by the same predicate as the launch gate, so a
        // half-written production build cannot shadow a working dev build and
        // turn into exit 71.
        const root = fakeRepo()
        build(root, 'chrome-mv3', { manifest_version: 3, name: 'no version' })
        const dev = build(root, 'chrome-mv3-dev')

        expect(resolveDefaultExtDir(root)).toBe(dev)
    })

    it('still yields an UNLOADABLE path when the checkout holds no build', () => {
        // The refusal is not weakened: with nothing built, the default must
        // remain something `assertLoadableExtension` rejects. Silently landing
        // on a directory that merely exists is the empty-browser bug.
        const root = fakeRepo()

        const resolved = resolveDefaultExtDir(root)
        expect(resolved).toBe(legacyExtDir(root))
        expect(extensionLoadProblem(resolved)).toMatch(/no manifest\.json/)
    })

    it('names the broken build rather than an unbuilt directory', () => {
        const root = fakeRepo()
        const prod = build(root, 'chrome-mv3', { manifest_version: 3 })

        const resolved = resolveDefaultExtDir(root)
        expect(resolved).toBe(prod)
        expect(extensionLoadProblem(resolved)).toMatch(/no version/i)
    })

    it('offers only chrome builds — Chromium cannot load the others', () => {
        const root = fakeRepo()
        build(root, 'firefox-mv3')
        build(root, 'safari-mv2')

        expect(extBuildOutputs(root).every(d => d.includes('chrome-mv3'))).toBe(
            true,
        )
        // ...and a checkout holding ONLY those builds still refuses, instead
        // of launching Chromium at an extension it cannot install.
        const resolved = resolveDefaultExtDir(root)
        expect(extensionLoadProblem(resolved)).not.toBeNull()
    })
})
