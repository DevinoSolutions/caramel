// A probe that cannot load the extension must never produce a verdict.
//
// Chromium accepts `--load-extension=<dir>` at a directory with no manifest,
// says nothing a caller can see, and runs an ordinary browser with nothing
// installed. Every measurement taken that way reports the same thing — no
// prompt, no coupons, nothing submitted — which is indistinguishable from a
// genuinely broken store config. That is what happened after the WXT migration
// moved the build to `.output/chrome-mv3` and left `apps/caramel-extension`
// (the probe's own default) without a manifest: days of ext-QA verdicts were
// measurements of an empty browser, and the only tell in the whole report was
// `vnull` in the log header.
//
// So this suite spawns the REAL probe. Nothing is stubbed and no store is
// touched: the refusal happens before Chromium is launched, which is the
// property being pinned.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
    exitCodeFor,
    PROBE_NO_EXTENSION,
    SCHEMA,
} from '../../../tools/ext-probe/verdict.mjs'

const PROBE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'tools',
    'ext-probe',
    'probe.mjs',
)

// A URL that is never reached: the refusal is decided from the filesystem, so
// a run that somehow got as far as the network would be the failure this suite
// exists to catch. A closed local port rather than an unresolvable host —
// connection-refused is immediate, where a bogus TLD spends ~50s in the DNS
// resolver and made the red-proof below race its own timeout.
const UNREACHED = 'http://127.0.0.1:1/cart'

function runProbe(extDir) {
    const res = spawnSync(
        process.execPath,
        [PROBE, UNREACHED, '--tag', 'no-extension-pin'],
        {
            env: { ...process.env, EXT_DIR: extDir },
            encoding: 'utf8',
            timeout: 60000,
        },
    )
    return res
}

function reportFrom(res) {
    // The one-object contract holds on this path too, or a caller that parses
    // stdout has to special-case the very outcome it most needs to see.
    return JSON.parse(res.stdout)
}

describe('the probe refuses to run without a loadable extension', () => {
    it('exits with the PROBE_NO_EXTENSION code when the directory has no manifest', () => {
        const empty = mkdtempSync(join(tmpdir(), 'ext-probe-empty-'))
        const res = runProbe(empty)

        expect(res.status).toBe(exitCodeFor(PROBE_NO_EXTENSION))
        expect(res.status).toBe(71)
        const report = reportFrom(res)
        expect(report.schema).toBe(SCHEMA)
        expect(report.verdict).toBe(PROBE_NO_EXTENSION)
        expect(report.exitCode).toBe(res.status)
    })

    it('names the directory it was given and where a build actually lands', () => {
        const empty = mkdtempSync(join(tmpdir(), 'ext-probe-empty-'))
        const reason = reportFrom(runProbe(empty)).reasons.join(' ')

        expect(reason).toContain(empty)
        expect(reason).toContain('.output/chrome-mv3')
        // The consequence, spelled out — the number 71 alone would not tell
        // the next reader why an empty browser is worse than a crash.
        expect(reason).toMatch(/measurement of an empty browser/i)
    })

    it('refuses a manifest that exists but Chromium could not load either', () => {
        const broken = mkdtempSync(join(tmpdir(), 'ext-probe-broken-'))
        writeFileSync(join(broken, 'manifest.json'), '{ not json', 'utf8')
        expect(runProbe(broken).status).toBe(71)

        const versionless = mkdtempSync(join(tmpdir(), 'ext-probe-noversion-'))
        writeFileSync(
            join(versionless, 'manifest.json'),
            JSON.stringify({ manifest_version: 3, name: 'x' }),
            'utf8',
        )
        const res = runProbe(versionless)
        expect(res.status).toBe(71)
        expect(reportFrom(res).reasons.join(' ')).toMatch(/no version/i)
    })

    it('is not counted as a store verdict, and not confused with a crash', () => {
        const empty = mkdtempSync(join(tmpdir(), 'ext-probe-empty-'))
        const report = reportFrom(runProbe(empty))
        // 70 is the generic harness crash; a caller that tolerates flaky
        // crashes must still stop dead on "there was no extension".
        expect(report.exitCode).not.toBe(70)
        expect(report.observation).toBeNull()
        expect(report.build).toBeNull()
    })

    it('RED-PROOF: the same probe reaches the launch path when a manifest IS present', () => {
        // Without this, every assertion above would pass just as well against
        // a probe that refused to run for some unrelated reason. A minimal
        // manifest is enough to get past the gate — the run then fails on the
        // unreachable URL, which is a DIFFERENT outcome and a different code.
        const ok = mkdtempSync(join(tmpdir(), 'ext-probe-ok-'))
        writeFileSync(
            join(ok, 'manifest.json'),
            JSON.stringify({
                manifest_version: 3,
                name: 'pin',
                version: '0.0.1',
            }),
            'utf8',
        )
        const res = runProbe(ok)
        expect(res.status).not.toBe(71)
        expect(reportFrom(res).verdict).not.toBe(PROBE_NO_EXTENSION)
        // The header resolved a real version instead of the `vnull` that was
        // the only tell for days...
        expect(res.stderr).toContain('v0.0.1')
        // ...and the launch really happened at the desktop viewport, which is
        // the one place that default can be observed end to end.
        expect(res.stderr).toContain('viewport 1920x1080')
    }, 120000)
})
