import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CARAMEL_HOST_CSS } from '../UI-helpers.js'

// The element IDs the extension injects are a CROSS-REPO CONTRACT, and nothing
// was holding the two ends together.
//
// The extension owns the ids: it creates each shadow host as a bare <div> whose
// id is a key of `CARAMEL_HOST_CSS` (UI-helpers.js). The ext-probe, which lives
// in `tools/ext-probe` and is driven from the caramel-coupons repo, hardcodes
// its own copy of one of them:
//
//     const PROMPT_HOST_ID = 'caramel-small-prompt'      // probe.mjs
//
// and every prompt observation it makes goes through that string —
// `getElementById(PROMPT_HOST_ID)` for "did the prompt render", the geometry
// read behind it, and `click('#' + PROMPT_HOST_ID)`.
//
// Rename the host in the extension and the rename looks completely safe: the id
// moves, `CARAMEL_HOST_CSS` moves with it, and the suites that assert against
// `CARAMEL_HOST_CSS['caramel-small-prompt']` move too, so the extension stays
// green. The probe does not move. It then reports, on every store forever, that
// no prompt rendered — which is byte-identical to what it reports for a
// genuinely broken store config, so ext-QA marks healthy stores red and the
// confidence cap keeps them out of the WORKING band. Nothing errors, nothing is
// logged, and the failure is only visible as "suddenly every store is bad".
//
// That is the same silent-measurement class as loading no extension at all
// (see ext-probe-extension-required.test.mjs); this pins the other half.
//
// The probe is read as TEXT rather than imported: it is an executable entry
// point in another workspace that launches Chromium at import time, and this
// pin must not depend on that. The literal is the contract, so the literal is
// what gets read.

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE_PATH = join(
    HERE,
    '..',
    '..',
    '..',
    'tools',
    'ext-probe',
    'probe.mjs',
)

/** Every `const NAME = 'value'` id constant the probe pins, as a {name: value} map. */
function probeHostIdConstants() {
    const src = readFileSync(PROBE_PATH, 'utf8')
    const found = {}
    for (const m of src.matchAll(
        /const\s+([A-Z0-9_]*HOST_ID)\s*=\s*['"]([^'"]+)['"]/g,
    ))
        found[m[1]] = m[2]
    return found
}

describe('ext-probe host id contract', () => {
    it('the probe file is where this test thinks it is', () => {
        // A moved probe would make every assertion below vacuously pass by
        // throwing somewhere else, so the path itself is asserted first.
        expect(() => readFileSync(PROBE_PATH, 'utf8')).not.toThrow()
    })

    it('the probe pins at least one host id (or this gate is measuring nothing)', () => {
        expect(Object.keys(probeHostIdConstants()).length).toBeGreaterThan(0)
    })

    it('every host id the probe hardcodes is one the extension actually injects', () => {
        const injected = Object.keys(CARAMEL_HOST_CSS)
        for (const [name, id] of Object.entries(probeHostIdConstants()))
            expect(
                injected,
                `probe.mjs pins ${name} = '${id}', but the extension injects ` +
                    `[${injected.join(', ')}]. Renaming a host without updating the ` +
                    `probe makes it report "no prompt rendered" on every store, which ` +
                    `is indistinguishable from a broken store config.`,
            ).toContain(id)
    })

    it('the prompt host specifically is still the id the probe clicks', () => {
        // Named explicitly rather than derived: the prompt is the one host the
        // probe INTERACTS with (click), so losing it silently costs the apply
        // half of every verdict, not just the render check.
        expect(probeHostIdConstants().PROMPT_HOST_ID).toBe(
            'caramel-small-prompt',
        )
        expect(CARAMEL_HOST_CSS).toHaveProperty('caramel-small-prompt')
    })
})
