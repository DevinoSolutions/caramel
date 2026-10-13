// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// /welcome's once-per-install dedupe. posthogBrowser, firstTouch, fetch and
// Sentry are TEST DOUBLES (…Mock); localStorage is jsdom's real one.

const { posthogBrowserMock } = vi.hoisted(() => ({
    posthogBrowserMock: {
        capturePosthog: vi.fn(),
        getLoadedPosthog: vi.fn(),
        isPosthogActive: vi.fn(),
        withPosthog: vi.fn(),
    },
}))
vi.mock('@/lib/analytics/posthogBrowser', () => posthogBrowserMock)

const { firstTouchMock } = vi.hoisted(() => ({
    firstTouchMock: { captureFirstTouch: vi.fn() },
}))
vi.mock('@/lib/analytics/firstTouch', () => firstTouchMock)

const { sentryMock } = vi.hoisted(() => ({
    sentryMock: { captureException: vi.fn() },
}))
vi.mock('@sentry/nextjs', () => sentryMock)

vi.mock('next/link', () => ({
    default: ({
        href,
        children,
        ...rest
    }: {
        href: string
        children: React.ReactNode
    }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}))

import WelcomePageClient from '@/app/welcome/WelcomePageClient'
import { recordExtensionInstalled } from '@/lib/analytics/extensionInstalled'
import { parseWelcomeParams } from '@/lib/extensionInstall'

const IID = '11111111-1111-4111-8111-111111111111'
const PARAMS = { store: 'chrome', extensionVersion: '1.4.6', iid: IID } as const
const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

beforeEach(() => {
    window.localStorage.clear()
    // A fresh Response per call: a body can only be read once.
    fetchMock
        .mockReset()
        .mockImplementation(async () => jsonResponse({ captured: true }))
    vi.stubGlobal('fetch', fetchMock)
    posthogBrowserMock.capturePosthog.mockReset()
    posthogBrowserMock.getLoadedPosthog
        .mockReset()
        .mockReturnValue({ get_distinct_id: () => 'browser-id' })
    posthogBrowserMock.isPosthogActive.mockReset().mockReturnValue(true)
    posthogBrowserMock.withPosthog.mockReset()
    firstTouchMock.captureFirstTouch.mockReset().mockReturnValue(null)
    sentryMock.captureException.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('recordExtensionInstalled', () => {
    it('captures in the browser (uuid = iid) and posts to the server, then reports recorded', async () => {
        const result = await recordExtensionInstalled(PARAMS)

        expect(result).toBe('recorded')
        expect(posthogBrowserMock.capturePosthog).toHaveBeenCalledTimes(1)
        const [event, props, , options] =
            posthogBrowserMock.capturePosthog.mock.calls[0]!
        expect(event).toBe('extension_installed')
        expect(props).toMatchObject({
            store: 'chrome',
            extension_version: '1.4.6',
            iid: IID,
            source: 'chrome_web_store_organic',
            capture_path: 'browser',
        })
        expect(options).toEqual({ uuid: IID })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0]!
        expect(url).toBe('/api/ext/installed')
        expect(JSON.parse(init.body)).toEqual({
            store: 'chrome',
            extension_version: '1.4.6',
            iid: IID,
            distinct_id: 'browser-id',
        })
    })

    it('carries the first-touch source and first_* properties when the visitor has a record', async () => {
        firstTouchMock.captureFirstTouch.mockReturnValue({
            utm_source: 'reddit',
            gclid: 'g1',
            captured_at: '2026-10-01T00:00:00.000Z',
        })
        await recordExtensionInstalled(PARAMS)
        expect(
            posthogBrowserMock.capturePosthog.mock.calls[0]![1],
        ).toMatchObject({
            source: 'reddit',
            first_utm_source: 'reddit',
            first_gclid: 'g1',
        })
    })

    it('dedupes: a reload of the same install id sends nothing again', async () => {
        await recordExtensionInstalled(PARAMS)
        const again = await recordExtensionInstalled(PARAMS)

        expect(again).toBe('already_recorded')
        expect(posthogBrowserMock.capturePosthog).toHaveBeenCalledTimes(1)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('a different install id is a different install', async () => {
        await recordExtensionInstalled(PARAMS)
        const other = await recordExtensionInstalled({
            ...PARAMS,
            iid: '22222222-2222-4222-8222-222222222222',
        })
        expect(other).toBe('recorded')
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('a failed POST is reported, returns "failed", and a retry re-posts WITHOUT re-sending the browser event', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))

        const first = await recordExtensionInstalled(PARAMS)
        expect(first).toBe('failed')
        expect(sentryMock.captureException).toHaveBeenCalledTimes(1)

        const retry = await recordExtensionInstalled(PARAMS)
        expect(retry).toBe('recorded')
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(posthogBrowserMock.capturePosthog).toHaveBeenCalledTimes(1)
    })

    it('captured:false from the server is a failure (checked, not assumed)', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ captured: false }))
        expect(await recordExtensionInstalled(PARAMS)).toBe('failed')
        expect(sentryMock.captureException).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringMatching(/did not capture/),
            }),
            expect.anything(),
        )
        // No server guard was written: the next load tries again.
        expect(
            window.localStorage.getItem(`cm_ext_installed_server:${IID}`),
        ).toBeNull()
    })

    it('an unexpected response shape and a network error are both failures', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
        expect(await recordExtensionInstalled(PARAMS)).toBe('failed')

        fetchMock.mockRejectedValueOnce(new TypeError('network down'))
        expect(await recordExtensionInstalled(PARAMS)).toBe('failed')
    })

    it('with PostHog off it still posts (no distinct_id) so the server count survives a blocker', async () => {
        posthogBrowserMock.getLoadedPosthog.mockReturnValue(null)
        posthogBrowserMock.isPosthogActive.mockReturnValue(false)

        expect(await recordExtensionInstalled(PARAMS)).toBe('recorded')
        expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).not.toHaveProperty(
            'distinct_id',
        )
    })

    it('storage that throws is reported and treated as no guard; the install is still sent', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('storage disabled')
        })
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('storage disabled')
        })

        expect(await recordExtensionInstalled(PARAMS)).toBe('recorded')
        expect(sentryMock.captureException).toHaveBeenCalled()
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})

describe('WelcomePageClient', () => {
    it('records the install once on mount and shows the browser-specific pin tip', async () => {
        const install = parseWelcomeParams({
            src: 'ext',
            store: 'firefox',
            v: '1.4.6',
            iid: IID,
        })
        expect(install).not.toBeNull()

        const view = render(<WelcomePageClient install={install} />)
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

        expect(view.getByText(/Pin to Toolbar/)).toBeTruthy()
        expect(
            view.getByRole('link', { name: 'Create an account' }),
        ).toBeTruthy()
        // The browser the user is on is not offered as "another browser".
        expect(view.queryByText('Caramel for Firefox')).toBeNull()
        expect(view.getByText('Caramel for Chrome')).toBeTruthy()

        view.rerender(<WelcomePageClient install={install} />)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('records nothing when the URL is not a valid install (a bare /welcome visit)', async () => {
        render(<WelcomePageClient install={null} />)
        await Promise.resolve()
        expect(fetchMock).not.toHaveBeenCalled()
        expect(posthogBrowserMock.capturePosthog).not.toHaveBeenCalled()
    })
})

describe('parseWelcomeParams', () => {
    it('accepts exactly the URL the extension builds', () => {
        expect(
            parseWelcomeParams({
                src: 'ext',
                store: 'edge',
                v: '1.4.6',
                iid: IID,
            }),
        ).toEqual({ store: 'edge', extensionVersion: '1.4.6', iid: IID })
    })

    it.each([
        [
            'a different src',
            { src: 'email', store: 'chrome', v: '1.4.6', iid: IID },
        ],
        [
            'an unknown store',
            { src: 'ext', store: 'opera', v: '1.4.6', iid: IID },
        ],
        [
            'a bad version',
            { src: 'ext', store: 'chrome', v: 'latest', iid: IID },
        ],
        ['a bad iid', { src: 'ext', store: 'chrome', v: '1.4.6', iid: 'abc' }],
        ['a missing iid', { src: 'ext', store: 'chrome', v: '1.4.6' }],
    ])('rejects %s', (_label, params) => {
        expect(parseWelcomeParams(params)).toBeNull()
    })

    it('uses the first value of a repeated param (deterministic, never an array downstream)', () => {
        expect(
            parseWelcomeParams({
                src: 'ext',
                store: ['edge', 'chrome'],
                v: '1.4.6',
                iid: IID,
            })?.store,
        ).toBe('edge')
    })
})
