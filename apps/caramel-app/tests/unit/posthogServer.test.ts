import { captureServerEvent } from '@/lib/analytics/posthogServer'
import { describe, expect, it } from 'vitest'

// The test env leaves POSTHOG_DATASET unset → 'disabled', and no NEXT_PUBLIC
// PostHog pair is configured, so the server capture must be a safe no-op: it
// returns false WITHOUT constructing a client or making a network call, and it
// never throws. (The live-send path is exercised by the deployed E2E project,
// not here — this is the disabled-mode contract that keeps the whole unit
// suite offline and free.)
describe('captureServerEvent (disabled mode)', () => {
    it('returns false and does not throw when the dataset is disabled', async () => {
        await expect(
            captureServerEvent({
                event: 'app_server_started',
                distinctId: 'caramel-server',
                properties: { node_runtime: 'nodejs' },
            }),
        ).resolves.toBe(false)
    })
})
