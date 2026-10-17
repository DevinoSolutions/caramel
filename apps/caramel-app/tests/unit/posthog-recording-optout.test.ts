import { initPosthogInstance } from '@/lib/analytics/identity'
import type { PosthogTarget } from '@/lib/analytics/posthogDataset'
import type { PostHog } from 'posthog-js'
import { afterEach, describe, expect, it, vi } from 'vitest'

// MOCK: fake PostHog client that records init options and recording starts.
// Named so it cannot be mistaken for the real SDK.
function fakePosthogClient() {
    return {
        init: vi.fn(),
        register: vi.fn(),
        get_session_id: vi.fn(() => 'session-test'),
        get_distinct_id: vi.fn(() => 'distinct-test'),
        startSessionRecording: vi.fn(),
    }
}

const target = {
    token: 'phc_test',
    environment: 'test',
} as unknown as PosthogTarget

function initWith(deferRecording: boolean) {
    const client = fakePosthogClient()
    initPosthogInstance(client as unknown as PostHog, target, {
        isE2E: false,
        deferRecording,
    })
    return client
}

describe('PostHog session recording honours GPC/DNT', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('disables recording at init when GPC is on, and masks .ph-sensitive', () => {
        vi.stubGlobal('navigator', { globalPrivacyControl: true })
        const client = initWith(false)
        const options = client.init.mock.calls[0]?.[1]
        expect(options.disable_session_recording).toBe(true)
        expect(options.session_recording.maskTextSelector).toContain(
            '.ph-sensitive',
        )
    })

    it('leaves recording on without an opt-out signal', () => {
        vi.stubGlobal('navigator', { doNotTrack: '0' })
        const client = initWith(false)
        expect(client.init.mock.calls[0]?.[1].disable_session_recording).toBe(
            false,
        )
    })

    it('never starts a deferred recording when DNT is on', () => {
        vi.stubGlobal('navigator', { doNotTrack: '1' })
        const client = initWith(true)
        expect(client.startSessionRecording).not.toHaveBeenCalled()
        expect(client.init.mock.calls[0]?.[1].disable_session_recording).toBe(
            true,
        )
    })
})
