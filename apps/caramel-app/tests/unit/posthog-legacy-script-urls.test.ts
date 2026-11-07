import { initPosthogInstance } from '@/lib/analytics/identity'
import type { PosthogTarget } from '@/lib/analytics/posthogDataset'
import type { PostHog } from 'posthog-js'
import { describe, expect, it, vi } from 'vitest'

// MOCK: fake PostHog client that records init options. Named so it cannot be
// mistaken for the real SDK.
function fakePosthogClient() {
    return {
        init: vi.fn(),
        register: vi.fn(),
        get_session_id: vi.fn(() => 'session-test'),
        get_distinct_id: vi.fn(() => 'distinct-test'),
        startSessionRecording: vi.fn(),
    }
}

describe('PostHog loads its lazy scripts (session recorder, etc.) from the legacy URL only', () => {
    // The self-hosted PostHog has no /static/<version>/<kind>.js paths and
    // redirects them to its /login, which lands on grabcaramel.com/login. With
    // posthog-js's default ('fallback') every recorder load first took that
    // detour before retrying the legacy /static/<kind>.js?v=<version> URL.
    it.each(['production', 'e2e'] as const)(
        'turns strict script versioning off (%s dataset)',
        environment => {
            const client = fakePosthogClient()
            initPosthogInstance(
                client as unknown as PostHog,
                {
                    token: 'phc_test',
                    host: 'https://ph.example',
                    environment,
                } satisfies PosthogTarget,
                { isE2E: false, deferRecording: false },
            )
            expect(
                client.init.mock.calls[0]?.[1].strict_script_versioning,
            ).toBe(false)
        },
    )
})
