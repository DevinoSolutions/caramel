import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

// LIVE check of deletePosthogPerson against a REAL PostHog project (T-7505).
// SKIPPED unless every POSTHOG_PERSON_DELETE_ITEST_* variable below is set, so
// CI and a plain `pnpm test:integration` never reach PostHog.
//
// NEVER POINT THIS AT THE PRODUCTION PROJECT (project id 6 is refused outright). It creates a fixture person with
// a random id, deletes it, and touches nothing else, but it uses a personal
// API key with person:write. Use a throwaway project (PostHog Cloud free
// project, or a scratch project on the self-hosted instance):
//
//   POSTHOG_PERSON_DELETE_ITEST_HOST=https://posthog.scratch.example
//   POSTHOG_PERSON_DELETE_ITEST_PROJECT_ID=123            (numeric)
//   POSTHOG_PERSON_DELETE_ITEST_CAPTURE_TOKEN=phc_...     (that project's token)
//   POSTHOG_PERSON_DELETE_ITEST_PERSONAL_API_KEY=phx_...  (person:write + person:read)
//   POSTHOG_PERSON_DELETE_ITEST_NOT_PRODUCTION=yes        (you confirm the above)
//
//   pnpm --filter caramel-app test:integration -- posthog-person-deletion
//
// PostHog deletes in the background, so the test polls (up to ~90 s) for the
// person to appear after capture and to disappear after our delete.
const HOST = process.env.POSTHOG_PERSON_DELETE_ITEST_HOST
const PROJECT_ID = process.env.POSTHOG_PERSON_DELETE_ITEST_PROJECT_ID
const CAPTURE_TOKEN = process.env.POSTHOG_PERSON_DELETE_ITEST_CAPTURE_TOKEN
const API_KEY = process.env.POSTHOG_PERSON_DELETE_ITEST_PERSONAL_API_KEY
const CONFIRMED_NOT_PROD =
    process.env.POSTHOG_PERSON_DELETE_ITEST_NOT_PRODUCTION === 'yes'

// Project 6 is Caramel's production project on the self-hosted instance; the
// scratch project must be a different one even if the host and tokens differ.
const PRODUCTION_PROJECT_ID = '6'

const configured = Boolean(
    HOST && PROJECT_ID && CAPTURE_TOKEN && API_KEY && CONFIRMED_NOT_PROD,
)
const pointsAtProduction =
    configured &&
    (PROJECT_ID!.trim() === PRODUCTION_PROJECT_ID ||
        (Boolean(process.env.NEXT_PUBLIC_POSTHOG_HOST) &&
            new URL(HOST!).origin ===
                new URL(process.env.NEXT_PUBLIC_POSTHOG_HOST!).origin &&
            Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY) &&
            CAPTURE_TOKEN === process.env.NEXT_PUBLIC_POSTHOG_KEY))

// deletePosthogPerson reads these two modules; stand them in with the scratch
// project so the REAL fetch path runs.
vi.mock('@/lib/env', () => ({
    env: {
        POSTHOG_PERSONAL_API_KEY:
            process.env.POSTHOG_PERSON_DELETE_ITEST_PERSONAL_API_KEY,
        POSTHOG_PROJECT_ID: process.env.POSTHOG_PERSON_DELETE_ITEST_PROJECT_ID,
    },
}))
vi.mock('@/lib/analytics/posthogServer', () => ({
    resolveServerTarget: () => ({
        host: process.env.POSTHOG_PERSON_DELETE_ITEST_HOST,
        token: process.env.POSTHOG_PERSON_DELETE_ITEST_CAPTURE_TOKEN,
        environment: 'e2e',
    }),
}))

const POLL_MS = 3000
const POLL_ATTEMPTS = 30

async function personCount(distinctId: string): Promise<number> {
    const url = new URL(`/api/projects/${PROJECT_ID}/persons/`, HOST)
    url.searchParams.set('distinct_id', distinctId)
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${API_KEY}` },
    })
    if (!res.ok) throw new Error(`persons lookup failed: ${res.status}`)
    const body = (await res.json()) as { results: unknown[] }
    return body.results.length
}

async function waitForCount(distinctId: string, want: 'present' | 'gone') {
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
        const n = await personCount(distinctId)
        if (want === 'present' ? n > 0 : n === 0) return
        await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }
    throw new Error(`person never became ${want}: ${distinctId}`)
}

describe.skipIf(!configured)(
    'deletePosthogPerson against a scratch PostHog project',
    () => {
        const fixtureId = `itest-person-delete-${randomUUID()}`

        afterAll(async () => {
            // Belt and braces: never leave the fixture behind if an assertion failed.
            if (!configured || pointsAtProduction) return
            await fetch(
                new URL(
                    `/api/projects/${PROJECT_ID}/persons/bulk_delete/`,
                    HOST,
                ),
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        distinct_ids: [fixtureId],
                        delete_events: true,
                    }),
                },
            )
        })

        it('refuses to run against the production capture pair', () => {
            expect(pointsAtProduction).toBe(false)
        })

        it('creates a fixture person, deletes it through our module, and the person is gone', async () => {
            expect(pointsAtProduction).toBe(false)

            const capture = await fetch(new URL('/i/v0/e/', HOST), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_key: CAPTURE_TOKEN,
                    event: 'itest_person_delete_fixture',
                    distinct_id: fixtureId,
                    properties: { $set: { itest: true } },
                }),
            })
            expect(capture.ok).toBe(true)
            await waitForCount(fixtureId, 'present')

            const { deletePosthogPerson } =
                await import('@/lib/analytics/posthogPersonDeletion')
            expect(await deletePosthogPerson(fixtureId)).toBe('deleted')

            await waitForCount(fixtureId, 'gone')
        }, 240_000)

        it('a user id PostHog never saw is also a success', async () => {
            expect(pointsAtProduction).toBe(false)
            const { deletePosthogPerson } =
                await import('@/lib/analytics/posthogPersonDeletion')
            expect(
                await deletePosthogPerson(`itest-never-seen-${randomUUID()}`),
            ).toBe('deleted')
        })
    },
)
