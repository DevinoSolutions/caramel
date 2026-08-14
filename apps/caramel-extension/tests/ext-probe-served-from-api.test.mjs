// The witness that proves the config under test is the config that was served.
//
// `config.servedFromApi` used to be `consoleTrail.some(l => l.includes('Loaded
// supported domains from API'))`. That line comes from `log` in
// caramel-base.js, which is `CARAMEL_ENV.verbose ? console.log : noop`, and
// the production stamp sets `verbose: false` on purpose — content scripts run
// on every https origin, so a shipped build must never write into a shopper's
// store console.
//
// So on the build ext-QA actually measures the line can never appear, silence
// was recorded as `false`, and classify's FIRST config gate fired on every
// single run: 10/10 probe artifacts over 36 hours came back
// INCONCLUSIVE_CONFIG_STALE, and the served-vs-expected comparison behind that
// gate had never once executed. Verified in the built artifacts on 2026-08-14:
// `.output/chrome-mv3` carries `verbose:!1`, `.output/chrome-mv3-dev` carries
// `verbose:!0`.
//
// The fix reads the extension's own STORAGE instead, which is stamped in both
// builds. These pins are about that asymmetry: storage can prove or disprove,
// the console can only ever confirm.
import { describe, expect, it } from 'vitest'
import {
    classify,
    deriveServedFromApi,
} from '../../../tools/ext-probe/verdict.mjs'
import { greenObservation } from './_ext-probe-fixtures.mjs'

describe('served-from-API is read from storage, not from a log line', () => {
    it('a cleared cache that came back holding data proves the fetch', () => {
        // The probe removes the key before the run and the extension rewrites
        // it only on the branch that just fetched from the API.
        expect(
            deriveServedFromApi({
                cacheCleared: true,
                cacheReadOk: true,
                cacheHasData: true,
            }),
        ).toBe(true)
    })

    it('a cleared cache that stayed empty DISPROVES it', () => {
        expect(
            deriveServedFromApi({
                cacheCleared: true,
                cacheReadOk: true,
                cacheHasData: false,
            }),
        ).toBe(false)
    })

    it('works with a completely silent console — the production build case', () => {
        // The whole point: no log line anywhere, and the answer is still true.
        expect(
            deriveServedFromApi({
                cacheCleared: true,
                cacheReadOk: true,
                cacheHasData: true,
                loggedApiLoad: false,
            }),
        ).toBe(true)
    })

    it('RED-PROOF: the OLD rule calls that same run stale', () => {
        // The superseded derivation, spelled out against the same facts. If
        // someone restores it, this is the number that changes.
        const oldRule = ({ loggedApiLoad }) => loggedApiLoad
        const productionRun = {
            cacheCleared: true,
            cacheReadOk: true,
            cacheHasData: true,
            loggedApiLoad: false,
        }
        expect(oldRule(productionRun)).toBe(false)
        expect(deriveServedFromApi(productionRun)).toBe(true)
    })

    it('the console line still CONFIRMS when storage could not be read', () => {
        // Independent witnesses are the probe's design; the console one is
        // kept, just demoted to something that can only say yes.
        expect(
            deriveServedFromApi({
                cacheCleared: false,
                loggedApiLoad: true,
            }),
        ).toBe(true)
    })

    it('neither witness available is null — never false', () => {
        // "We did not see it" and "it did not happen" lead to different
        // verdicts, and collapsing them is how a harness starts lying.
        expect(deriveServedFromApi({})).toBeNull()
        expect(
            deriveServedFromApi({ cacheCleared: true, cacheReadOk: false }),
        ).toBeNull()
    })

    it('an uncleared cache holding data is NOT proof — it could be yesterday', () => {
        expect(
            deriveServedFromApi({
                cacheCleared: false,
                cacheReadOk: true,
                cacheHasData: true,
            }),
        ).toBeNull()
    })
})

describe('the stale gate says which of the two situations it is in', () => {
    it('names the cleared-and-never-refilled case', () => {
        const r = classify(
            greenObservation({
                config: { servedFromApi: false, cacheClearedBeforeRun: true },
            }),
        )
        expect(r.verdict).toBe('INCONCLUSIVE_CONFIG_STALE')
        expect(r.reasons.join(' ')).toMatch(/never came back/)
    })

    it('names the could-not-clear case differently — a different fix', () => {
        const r = classify(
            greenObservation({
                config: { servedFromApi: null, cacheClearedBeforeRun: false },
            }),
        )
        expect(r.verdict).toBe('INCONCLUSIVE_CONFIG_STALE')
        expect(r.reasons.join(' ')).toMatch(/could not be cleared/)
    })

    it('a proven fresh fetch gets past the gate to the real comparison', () => {
        expect(
            classify(
                greenObservation({
                    config: {
                        servedFromApi: true,
                        cacheClearedBeforeRun: true,
                    },
                }),
            ).verdict,
        ).toBe('GREEN')
    })
})
