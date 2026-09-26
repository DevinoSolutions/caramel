// @vitest-environment jsdom
//
// The analytics deferral (posthog-js after load + idle, both session
// recorders at first activity) is scoped to the marketing landing route. Every
// other route (app, auth, OAuth callbacks, consent) must keep starting
// PostHog, its session recording and Sentry Replay at mount, exactly as before
// the landing-page performance work.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const scheduled = vi.hoisted(() => ({
    afterPageLoad: [] as Array<() => void>,
    onFirstActivity: [] as Array<() => void>,
}))

vi.mock('@/lib/afterPageLoad', async importActual => ({
    ...(await importActual<typeof import('@/lib/afterPageLoad')>()),
    afterPageLoad: (callback: () => void) =>
        scheduled.afterPageLoad.push(callback),
    onFirstActivity: (callback: () => void) =>
        scheduled.onFirstActivity.push(callback),
}))

const posthog = vi.hoisted(() => ({
    init: vi.fn(),
    register: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    startSessionRecording: vi.fn(),
    get_session_id: () => 'session-1',
    get_distinct_id: () => 'distinct-1',
}))
vi.mock('posthog-js', () => ({ default: posthog }))

const sentry = vi.hoisted(() => ({
    init: vi.fn(),
    addIntegration: vi.fn(),
    replayIntegration: vi.fn(() => ({ name: 'Replay' })),
    captureException: vi.fn(),
    captureRouterTransitionStart: vi.fn(),
    setTag: vi.fn(),
    setContext: vi.fn(),
    setUser: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => sentry)

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

// Resolves once every queued promise callback (the dynamic imports and their
// .then chains) has run.
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
}

function landOn(pathname: string): void {
    window.history.replaceState({}, '', pathname)
}

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    scheduled.afterPageLoad.length = 0
    scheduled.onFirstActivity.length = 0
})

describe('PostHog: deferred on the landing route only', () => {
    it.each(['/login', '/signup', '/oauth/consent', '/coupons', '/profile'])(
        '%s loads posthog-js at mount and records from init',
        async pathname => {
            landOn(pathname)
            const { initPosthogBrowser } = await import(
                '@/lib/analytics/identity'
            )
            expect(initPosthogBrowser()).toBe(true)
            await settle()

            expect(scheduled.afterPageLoad).toHaveLength(0)
            expect(posthog.init).toHaveBeenCalledTimes(1)
            expect(posthog.init.mock.calls[0][1]).toMatchObject({
                disable_session_recording: false,
            })
            expect(scheduled.onFirstActivity).toHaveLength(0)
        },
    )

    it('/ waits for load + idle, then records from the first activity', async () => {
        landOn('/')
        const { initPosthogBrowser } = await import('@/lib/analytics/identity')
        expect(initPosthogBrowser()).toBe(true)
        await settle()
        expect(posthog.init).not.toHaveBeenCalled()

        expect(scheduled.afterPageLoad).toHaveLength(1)
        scheduled.afterPageLoad[0]()
        await settle()
        expect(posthog.init).toHaveBeenCalledTimes(1)
        expect(posthog.init.mock.calls[0][1]).toMatchObject({
            disable_session_recording: true,
        })

        expect(posthog.startSessionRecording).not.toHaveBeenCalled()
        expect(scheduled.onFirstActivity).toHaveLength(1)
        scheduled.onFirstActivity[0]()
        expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1)
    })

    it('/ loses no event fired before posthog-js loads, and keeps its time', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        try {
            landOn('/')
            const { initPosthogBrowser } = await import(
                '@/lib/analytics/identity'
            )
            const { trackGrowthEvent } = await import(
                '@/lib/analytics/growthEvents'
            )
            initPosthogBrowser()

            vi.setSystemTime(new Date('2026-09-26T10:00:00.000Z'))
            trackGrowthEvent('prompt_shown', { prompt_id: 'first' })
            vi.setSystemTime(new Date('2026-09-26T10:00:02.000Z'))
            trackGrowthEvent('prompt_shown', { prompt_id: 'second' })
            expect(posthog.capture).not.toHaveBeenCalled()

            vi.setSystemTime(new Date('2026-09-26T10:00:05.000Z'))
            scheduled.afterPageLoad[0]()
            await settle()

            expect(posthog.capture).toHaveBeenCalledTimes(2)
            const [first, second] = posthog.capture.mock.calls
            expect(first[1]).toMatchObject({ prompt_id: 'first' })
            expect(first[2]).toEqual({
                timestamp: new Date('2026-09-26T10:00:00.000Z'),
            })
            expect(second[1]).toMatchObject({ prompt_id: 'second' })
            expect(second[2]).toEqual({
                timestamp: new Date('2026-09-26T10:00:02.000Z'),
            })
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('Sentry Replay: deferred on the landing route only', () => {
    beforeEach(() => {
        vi.stubEnv('NODE_ENV', 'production')
        vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://key@sentry.example/1')
        return () => vi.unstubAllEnvs()
    })

    it('/login starts the error SDK without Replay, then adds Replay at once', async () => {
        landOn('/login')
        await import('@/instrumentation-client')
        await settle()

        expect(sentry.init).toHaveBeenCalledTimes(1)
        expect(sentry.init.mock.calls[0][0]).toMatchObject({
            integrations: [],
            replaysOnErrorSampleRate: 1.0,
        })
        expect(scheduled.onFirstActivity).toHaveLength(0)
        expect(sentry.addIntegration).toHaveBeenCalledTimes(1)
    })

    it('/ adds Replay only at the first activity', async () => {
        landOn('/')
        await import('@/instrumentation-client')
        await settle()

        expect(sentry.init).toHaveBeenCalledTimes(1)
        expect(sentry.addIntegration).not.toHaveBeenCalled()
        expect(scheduled.onFirstActivity).toHaveLength(1)

        scheduled.onFirstActivity[0]()
        await settle()
        expect(sentry.addIntegration).toHaveBeenCalledTimes(1)
        expect(sentry.replayIntegration).toHaveBeenCalledWith(
            expect.objectContaining({ maskAllInputs: true }),
        )
    })
})
