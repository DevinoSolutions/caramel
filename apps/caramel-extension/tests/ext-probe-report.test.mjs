// The machine contract: one schema-versioned object, and an exit code that
// carries the verdict.
//
// These are the golden-shape tests. They exist because the thing this tool
// replaced exited 0 whether or not anything happened, and reported in prose —
// so "did that store pass?" could only be answered by a human reading English.
// A caller now branches on `verdict` and `exitCode`, which means the SHAPE is
// an API and a silent field rename is a breaking change.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
    buildReport,
    PROBE_ERROR,
    SCHEMA,
} from '../../../tools/ext-probe/verdict.mjs'
import {
    greenObservation,
    seedFailedObservation,
} from './_ext-probe-fixtures.mjs'

const TARGET = {
    url: 'https://example-store.test/cart',
    origin: 'https://example-store.test',
    viewportWidth: 390,
    tag: 'golden',
}
const BUILD = {
    extensionPath: '/repo/apps/caramel-extension',
    manifestName: 'Caramel',
    manifestVersion: '1.2.0',
    fileCount: 21,
    contentHash:
        'sha256:0000000000000000000000000000000000000000000000000000000000000000',
}
const WITNESSES = {
    console: { available: true, trail: [] },
    serviceWorker: { available: true, trail: [] },
    timings: { available: true, trail: [] },
    disagreement: {
        detected: false,
        timingsAtCap: false,
        details: [],
        consoleCounts: {},
        timingCounts: {},
    },
}

const TOP_LEVEL_KEYS = [
    'schema',
    'verdict',
    'exitCode',
    'reasons',
    'target',
    'build',
    'observation',
    'witnesses',
    'logFile',
    'screenshot',
    'durationMs',
]

function report(observation, extra = {}) {
    return buildReport({
        target: TARGET,
        build: BUILD,
        observation,
        witnesses: WITNESSES,
        logFile: '/repo/.ext-probe/ext-probe-golden-390.log',
        screenshot: '/repo/.ext-probe/ext-probe-golden-390.png',
        durationMs: 41230,
        ...extra,
    })
}

describe('golden run — GREEN', () => {
    const r = report(greenObservation())

    it('carries exactly the documented top-level keys', () => {
        expect(Object.keys(r).sort()).toEqual([...TOP_LEVEL_KEYS].sort())
    })

    it('is stamped with the schema version', () => {
        expect(r.schema).toBe(SCHEMA)
        expect(r.schema).toBe('ext-probe/1')
    })

    it('reports GREEN and exit 0', () => {
        expect(r.verdict).toBe('GREEN')
        expect(r.exitCode).toBe(0)
        expect(r.reasons.length).toBeGreaterThan(0)
    })

    it('echoes which build was measured, so that is never a question later', () => {
        expect(r.build).toEqual(BUILD)
        expect(r.build.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(r.build.manifestVersion).toBe('1.2.0')
    })

    it('echoes the target and the untruncated log location', () => {
        expect(r.target).toEqual(TARGET)
        expect(r.logFile).toMatch(/ext-probe-golden-390\.log$/)
    })

    it('keeps the cart-at-arrival reading and both witnesses in the payload', () => {
        expect(r.observation.cartItemsAtArrival).toBe(1)
        expect(r.witnesses.console.available).toBe(true)
        expect(r.witnesses.timings.available).toBe(true)
        expect(r.witnesses.disagreement.detected).toBe(false)
    })

    it('survives a round trip through JSON unchanged', () => {
        expect(JSON.parse(JSON.stringify(r))).toEqual(r)
    })
})

describe('golden run — INCONCLUSIVE_SEED', () => {
    const r = report(seedFailedObservation())

    it('has the same shape as the GREEN run', () => {
        expect(Object.keys(r).sort()).toEqual([...TOP_LEVEL_KEYS].sort())
        expect(r.schema).toBe('ext-probe/1')
    })

    it('reports INCONCLUSIVE_SEED and exit 30 — not a red', () => {
        expect(r.verdict).toBe('INCONCLUSIVE_SEED')
        expect(r.exitCode).toBe(30)
    })

    it('says why in machine-independent English, on the record', () => {
        expect(r.reasons.join(' ')).toMatch(/seed did not succeed/i)
        expect(r.reasons.join(' ')).toContain('rate-limit the store')
    })

    it('preserves the seed cap evidence — 5 rejected adds, then it stopped', () => {
        expect(r.observation.seed.rejectedAdds).toBe(5)
        expect(r.observation.seed.adds).toBe(5)
    })

    it('leaves unobserved facts null, never false', () => {
        // "We did not see it" and "it did not happen" lead to different
        // verdicts; collapsing them is how a harness starts lying.
        expect(r.observation.coupons.count).toBeNull()
        expect(r.observation.apply.successFiredOnGoodCode).toBeNull()
        expect(r.observation.indicators.priceContainer).toBeNull()
    })
})

describe('a probe crash is reported as a crash', () => {
    const r = buildReport({ error: new Error('chromium never launched') })

    it('uses the PROBE_ERROR sentinel and exit 70', () => {
        expect(r.verdict).toBe(PROBE_ERROR)
        expect(r.exitCode).toBe(70)
    })

    it('still emits the schema so a caller can parse it the same way', () => {
        expect(r.schema).toBe('ext-probe/1')
        expect(r.reasons.join(' ')).toContain('chromium never launched')
    })

    it('does not invent an observation about the store', () => {
        expect(r.observation).toBeNull()
    })
})

describe('the real binary honours the contract', () => {
    // Hermetic: called with no target, the probe fails before it ever reaches
    // Chromium, so this exercises the actual stdout/stderr/exit-code wiring
    // without a browser, a network or a store.
    const probe = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'tools',
        'ext-probe',
        'probe.mjs',
    )
    const run = spawnSync(process.execPath, [probe], { encoding: 'utf8' })

    it('exits 70 — a probe that never ran is not a store verdict', () => {
        expect(run.status).toBe(70)
    })

    it('puts exactly one parseable JSON object on stdout', () => {
        const parsed = JSON.parse(run.stdout)
        expect(parsed.schema).toBe('ext-probe/1')
        expect(parsed.verdict).toBe(PROBE_ERROR)
        expect(parsed.exitCode).toBe(run.status)
    })

    it('puts the human prose on stderr, where it cannot corrupt the JSON', () => {
        expect(run.stderr).toContain('usage:')
        expect(run.stdout).not.toContain('usage:')
    })
})

describe('partial observations are filled in, not trusted blindly', () => {
    it('an empty observation is normalized to the full documented shape', () => {
        const r = buildReport({ observation: {} })
        expect(Object.keys(r.observation).sort()).toEqual(
            [
                'apply',
                'cartItemsAtArrival',
                'config',
                'coupons',
                'detection',
                'indicators',
                'platform',
                'prompt',
                'seed',
            ].sort(),
        )
        // Nothing observed at all still cannot read as a pass.
        expect(r.verdict).toBe('INCONCLUSIVE_SEED')
        expect(r.exitCode).not.toBe(0)
    })
})
