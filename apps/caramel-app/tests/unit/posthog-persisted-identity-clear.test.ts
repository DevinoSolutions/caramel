// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// T-7505: after an account deletion the browser must drop posthog-js's
// persisted distinct id even when the SDK never loaded (blocked, failed, still
// 'off'). Otherwise a stale ph_<token>_posthog survives and the next capture
// re-creates the deleted person.

const TOKEN = 'phc_test_token'
const KEY = `ph_${TOKEN}_posthog`

const { targetMock, sentryMock } = vi.hoisted(() => ({
    targetMock: {
        value: null as { token: string; environment: string } | null,
    },
    sentryMock: { captureException: vi.fn(), setUser: vi.fn() },
}))
vi.mock('@/lib/analytics/posthogDataset', () => ({
    APP_ID: 'caramel-web',
    resolveClientPosthogTarget: () => targetMock.value,
}))
vi.mock('@sentry/nextjs', () => sentryMock)

async function reset() {
    vi.resetModules()
    const { resetPosthogIdentity } = await import('@/lib/analytics/identity')
    resetPosthogIdentity()
}

function cookieJar() {
    const jar = new Map<string, string>()
    const writes: string[] = []
    Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: () => Array.from(jar, ([k, v]) => `${k}=${v}`).join('; '),
        set: (raw: string) => {
            writes.push(raw)
            const [pair = ''] = raw.split(';')
            const [name = '', value = ''] = pair.split('=')
            if (/max-age=0/i.test(raw)) jar.delete(name.trim())
            else jar.set(name.trim(), value)
        },
    })
    return { jar, writes }
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    targetMock.value = { token: TOKEN, environment: 'production' }
    window.localStorage.clear()
})
afterEach(() => vi.restoreAllMocks())

describe('resetPosthogIdentity when the PostHog SDK is not running', () => {
    it('removes the persisted localStorage id and expires the cookie on the host and parent domains', async () => {
        const { jar, writes } = cookieJar()
        window.localStorage.setItem(KEY, '{"distinct_id":"user-1"}')
        jar.set(KEY, '%7B%22distinct_id%22%3A%22user-1%22%7D')

        await reset()

        expect(window.localStorage.getItem(KEY)).toBeNull()
        expect(jar.has(KEY)).toBe(false)
        // jsdom's default host is localhost: the host-only expiry is always sent.
        expect(writes[0]).toBe(`${KEY}=; Max-Age=0; Path=/`)
    })

    it('expires the cross-subdomain cookie for every parent domain of the host', async () => {
        const { writes } = cookieJar()
        vi.stubGlobal('location', { hostname: 'www.grabcaramel.com' })
        window.localStorage.setItem(KEY, 'x')

        await reset()
        vi.unstubAllGlobals()

        expect(writes).toContain(
            `${KEY}=; Max-Age=0; Path=/; Domain=www.grabcaramel.com`,
        )
        expect(writes).toContain(
            `${KEY}=; Max-Age=0; Path=/; Domain=grabcaramel.com`,
        )
    })

    it('leaves unrelated storage alone', async () => {
        cookieJar()
        window.localStorage.setItem('caramel.first_touch', '{"a":1}')
        window.localStorage.setItem(KEY, 'x')

        await reset()

        expect(window.localStorage.getItem('caramel.first_touch')).toBe(
            '{"a":1}',
        )
    })

    it('does nothing when PostHog capture is disabled for this deploy', async () => {
        const { writes } = cookieJar()
        targetMock.value = null
        window.localStorage.setItem(KEY, 'x')

        await reset()

        expect(window.localStorage.getItem(KEY)).toBe('x')
        expect(writes).toHaveLength(0)
    })

    it('reports a storage failure to Sentry instead of swallowing it', async () => {
        cookieJar()
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
            throw new Error('storage blocked')
        })

        await reset()

        expect(sentryMock.captureException).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'storage blocked' }),
            { tags: { operation: 'posthog_clear_persisted' } },
        )
    })
})
