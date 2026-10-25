import * as Sentry from '@sentry/nextjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// deletePosthogPerson (T-7505): the server-side PostHog person + events delete
// that runs on account deletion. fetch is mocked; the live-PostHog check is
// tests/integration/posthog-person-deletion.itest.ts (skipped without env).

const USER_ID = 'b3f1c9a2-1111-4222-8333-444455556666'
const USER_EMAIL = 'shopper@example.com'

const envMock = vi.hoisted(() => ({
    POSTHOG_PERSONAL_API_KEY: 'phx_test_key' as string | undefined,
    POSTHOG_PROJECT_ID: '42' as string | undefined,
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

const targetMock = vi.hoisted(() => ({
    value: null as { host: string; token: string; environment: string } | null,
}))
vi.mock('@/lib/analytics/posthogServer', () => ({
    resolveServerTarget: () => targetMock.value,
}))

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))

const fetchMock = vi.fn<typeof fetch>()

async function run() {
    const { deletePosthogPerson } =
        await import('@/lib/analytics/posthogPersonDeletion')
    return deletePosthogPerson(USER_ID)
}

function sentryCalls() {
    return vi
        .mocked(Sentry.captureException)
        .mock.calls.map(([error, hint]) => ({ error, hint }))
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    envMock.POSTHOG_PERSONAL_API_KEY = 'phx_test_key'
    envMock.POSTHOG_PROJECT_ID = '42'
    targetMock.value = {
        host: 'https://posthog.example.test',
        token: 'phc_capture',
        environment: 'production',
    }
})
afterEach(() => vi.unstubAllGlobals())

describe('deletePosthogPerson', () => {
    it('POSTs bulk_delete for the user id with events and recordings, bearer-authenticated', async () => {
        fetchMock.mockResolvedValue(
            Response.json(
                {
                    persons_found: 1,
                    persons_queued_for_deletion: 1,
                    deletion_errors: [],
                },
                { status: 202 },
            ),
        )

        expect(await run()).toBe('deleted')

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0]!
        expect(String(url)).toBe(
            'https://posthog.example.test/api/projects/42/persons/bulk_delete/',
        )
        expect(init?.method).toBe('POST')
        const headers = init?.headers as Record<string, string>
        expect(headers.Authorization).toBe('Bearer phx_test_key')
        expect(JSON.parse(String(init?.body))).toEqual({
            distinct_ids: [USER_ID],
            delete_events: true,
            delete_recordings: true,
        })
        expect(Sentry.captureException).not.toHaveBeenCalled()
    })

    it('a person PostHog never had (found 0, or a 404) is success: nothing left to delete', async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json(
                { persons_found: 0, deletion_errors: [] },
                { status: 202 },
            ),
        )
        expect(await run()).toBe('deleted')

        fetchMock.mockResolvedValueOnce(
            Response.json({ detail: 'Not found.' }, { status: 404 }),
        )
        expect(await run()).toBe('deleted')
        expect(Sentry.captureException).not.toHaveBeenCalled()
    })

    it('a 5xx is a Sentry error and a failed outcome, never a throw', async () => {
        fetchMock.mockResolvedValue(new Response('boom', { status: 503 }))

        expect(await run()).toBe('failed')

        const [{ error, hint }] = sentryCalls()
        expect((error as Error).message).toContain('http_error')
        expect(hint).toMatchObject({
            tags: {
                route: 'account/delete',
                operation: 'posthog_person_delete',
                reason: 'http_error',
            },
            extra: { status: 503 },
        })
    })

    it('a network failure or timeout is a Sentry error with the cause as context', async () => {
        const cause = new Error('socket hang up')
        fetchMock.mockRejectedValue(cause)

        expect(await run()).toBe('failed')

        expect(sentryCalls()[0]!.hint).toMatchObject({
            tags: { reason: 'request_failed' },
            extra: { cause: 'Error: socket hang up' },
        })
    })

    it('deletion_errors in a 202 body is a failure', async () => {
        fetchMock.mockResolvedValue(
            Response.json(
                { persons_found: 1, deletion_errors: [{ id: 'x' }] },
                { status: 202 },
            ),
        )

        expect(await run()).toBe('failed')
        expect(sentryCalls()[0]!.hint).toMatchObject({
            tags: { reason: 'deletion_errors' },
        })
    })

    it.each([
        ['key unset', { POSTHOG_PERSONAL_API_KEY: undefined }],
        ['key blank', { POSTHOG_PERSONAL_API_KEY: '  ' }],
        ['project id unset', { POSTHOG_PROJECT_ID: undefined }],
    ])('%s: no call, a Sentry error, failed outcome', async (_name, patch) => {
        Object.assign(envMock, patch)

        expect(await run()).toBe('failed')

        expect(fetchMock).not.toHaveBeenCalled()
        expect(sentryCalls()[0]!.hint).toMatchObject({
            tags: { reason: 'not_configured' },
        })
    })

    it('a non-numeric project id is refused before any request (it goes into the URL path)', async () => {
        envMock.POSTHOG_PROJECT_ID = '42/../../x'

        expect(await run()).toBe('failed')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('dataset disabled: no call, no Sentry noise, not_applicable (logged)', async () => {
        targetMock.value = null

        expect(await run()).toBe('not_applicable')

        expect(fetchMock).not.toHaveBeenCalled()
        expect(Sentry.captureException).not.toHaveBeenCalled()
        expect(console.info).toHaveBeenCalled()
    })

    it('never puts the email, the key or the raw user id in Sentry or the log', async () => {
        fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))

        await run()

        const everything = JSON.stringify([
            sentryCalls(),
            vi.mocked(console.error).mock.calls,
        ])
        expect(everything).not.toContain(USER_EMAIL)
        expect(everything).not.toContain('phx_test_key')
        expect(everything).not.toContain(USER_ID)
    })
})
