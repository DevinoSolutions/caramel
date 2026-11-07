// @vitest-environment jsdom
//
// T-10055: an app-shell visit registers the shell's platform, version and
// build as PostHog super properties, so a bounce loop can be tied to a build.
//
// Runs the REAL posthogBrowser queue (off -> loading -> ready) and the real
// initPosthogBrowser; only the dynamic posthog-js import, the env and the
// capture target are stubbed. The registration has to survive being asked for
// in every state, because withPosthog drops work made while PostHog is `off`.
import { beforeEach, describe, expect, it, vi } from 'vitest'

// MOCK: a fake PostHog client. Like the real SDK, reset() drops every
// registered super property and the properties of a capture are the registered
// ones merged under the event's own.
const posthog = vi.hoisted(() => {
    let registered: Record<string, unknown> = {}
    const captured: Array<Record<string, unknown>> = []
    return {
        init: vi.fn(),
        register: vi.fn((properties: Record<string, unknown>) => {
            registered = { ...registered, ...properties }
        }),
        reset: vi.fn(() => {
            registered = {}
        }),
        capture: vi.fn(
            (_event: string, properties?: Record<string, unknown>) => {
                captured.push({ ...registered, ...properties })
            },
        ),
        captured,
        clearState: () => {
            registered = {}
            captured.length = 0
        },
        identify: vi.fn(),
        startSessionRecording: vi.fn(),
        get_session_id: () => 'session-1',
        get_distinct_id: () => 'distinct-1',
    }
})
vi.mock('posthog-js', () => ({ default: posthog }))

vi.mock('@sentry/nextjs', () => ({
    setTag: vi.fn(),
    setContext: vi.fn(),
    setUser: vi.fn(),
    captureException: vi.fn(),
}))
vi.mock('@/lib/env.client', () => ({
    APP_VERSION: '1.0.0-test',
    clientEnv: { NEXT_PUBLIC_POSTHOG_DATASET: 'production' },
}))
vi.mock('@/lib/analytics/firstTouch', () => ({ captureFirstTouch: () => null }))
vi.mock('@/lib/analytics/posthogDataset', () => ({
    APP_ID: 'caramel',
    resolveClientPosthogTarget: () => ({
        host: 'https://ph.example',
        token: 'phc_test',
        environment: 'production',
    }),
}))

function setUserAgent(userAgent: string): void {
    Object.defineProperty(window.navigator, 'userAgent', {
        value: userAgent,
        configurable: true,
    })
}

// Resolves once the dynamic import and the queued promise callbacks have run.
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

type Identity = typeof import('@/lib/analytics/identity')

async function freshIdentity(): Promise<Identity> {
    vi.resetModules()
    return import('@/lib/analytics/identity')
}

describe('app-shell PostHog super properties', () => {
    beforeEach(() => {
        posthog.init.mockClear()
        posthog.register.mockClear()
        posthog.clearState()
        // Not the landing route, whose PostHog load is deferred to idle time.
        window.history.pushState({}, '', '/coupons')
    })

    it('registers platform, shell version and build once PostHog is ready', async () => {
        setUserAgent(
            'Mozilla/5.0 (iPhone) Mobile/15E148 CaramelApp/1.6.0 (ios) CaramelBuild/42.1',
        )
        const identity = await freshIdentity()
        // Nothing has asked for PostHog yet: the state is `off`.
        expect(identity.isPosthogActive()).toBe(false)
        expect(identity.initPosthogBrowser()).toBe(true) // off -> loading
        expect(posthog.register).not.toHaveBeenCalled()
        await settle() // loading -> ready
        expect(posthog.register).toHaveBeenCalledWith({
            surface: 'app-shell',
            app_platform: 'ios',
            app_shell_version: '1.6.0',
            app_build: '42.1',
        })
    })

    it('registers nothing outside the app shell', async () => {
        setUserAgent('Mozilla/5.0 (iPhone) Mobile/15E148 Safari/604.1')
        const identity = await freshIdentity()
        identity.initPosthogBrowser()
        await settle()
        for (const [properties] of posthog.register.mock.calls) {
            expect(properties).not.toHaveProperty('surface')
            expect(properties).not.toHaveProperty('app_build')
        }
    })

    it('keeps the base and app-shell super properties on events captured after a logout reset (init -> reset -> capture)', async () => {
        setUserAgent(
            'Mozilla/5.0 (iPhone) Mobile/15E148 CaramelApp/1.6.0 (ios) CaramelBuild/42',
        )
        const identity = await freshIdentity()
        identity.initPosthogBrowser()
        await settle()
        posthog.capture('before_logout')
        identity.resetPosthogIdentity()
        posthog.capture('after_logout')
        expect(posthog.reset).toHaveBeenCalledTimes(1)
        const [before, after] = posthog.captured
        const base = {
            app_id: 'caramel',
            app_version: '1.0.0-test',
            environment: 'production',
            platform: 'web',
        }
        expect(before).toMatchObject({
            ...base,
            app_build: '42',
            surface: 'app-shell',
        })
        expect(after).toMatchObject({
            ...base,
            app_build: '42',
            app_shell_version: '1.6.0',
            app_platform: 'ios',
            surface: 'app-shell',
        })
    })

    it('keeps the base super properties after a reset outside the app shell', async () => {
        setUserAgent('Mozilla/5.0 (iPhone) Mobile/15E148 Safari/604.1')
        const identity = await freshIdentity()
        identity.initPosthogBrowser()
        await settle()
        identity.resetPosthogIdentity()
        posthog.capture('after_logout')
        const [after] = posthog.captured
        expect(after).toEqual({
            app_id: 'caramel',
            app_version: '1.0.0-test',
            environment: 'production',
            platform: 'web',
        })
    })
})
