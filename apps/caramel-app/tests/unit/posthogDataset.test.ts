import { resolvePosthogTarget } from '@/lib/analytics/posthogDataset'
import { describe, expect, it } from 'vitest'

// Feedback+observability foundation — the pure dataset resolver. Proves the
// routing table (production/e2e/disabled) and the "incomplete pair → no-op"
// safety, so a half-configured deploy silently disables capture instead of
// crashing or mis-routing.
describe('resolvePosthogTarget', () => {
    it('production with a full pair resolves to the production target', () => {
        expect(
            resolvePosthogTarget({
                dataset: 'production',
                productionHost: 'https://posthog.devino.ca',
                productionKey: 'phc_prod',
            }),
        ).toEqual({
            host: 'https://posthog.devino.ca',
            token: 'phc_prod',
            environment: 'production',
        })
    })

    it('e2e with a full pair resolves to the e2e target (never the prod pair)', () => {
        expect(
            resolvePosthogTarget({
                dataset: 'e2e',
                productionHost: 'https://posthog.devino.ca',
                productionKey: 'phc_prod',
                e2eHost: 'https://posthog.devino.ca',
                e2eToken: 'phc_e2e',
            }),
        ).toEqual({
            host: 'https://posthog.devino.ca',
            token: 'phc_e2e',
            environment: 'e2e',
        })
    })

    it('disabled always resolves to null', () => {
        expect(
            resolvePosthogTarget({
                dataset: 'disabled',
                productionHost: 'https://posthog.devino.ca',
                productionKey: 'phc_prod',
            }),
        ).toBeNull()
    })

    it('a configured dataset with an incomplete pair resolves to null (no-op, not a throw)', () => {
        expect(
            resolvePosthogTarget({
                dataset: 'production',
                productionHost: 'https://posthog.devino.ca',
            }),
        ).toBeNull()
        expect(
            resolvePosthogTarget({ dataset: 'e2e', e2eToken: 'phc_e2e' }),
        ).toBeNull()
    })
})
