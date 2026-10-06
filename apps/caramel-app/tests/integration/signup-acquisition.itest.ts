import {
    FIRST_TOUCH_COOKIE_NAME,
    serializeFirstTouchCookieValue,
} from '@/lib/analytics/firstTouchRecord'
import { recordSignup } from '@/lib/auth/signupCapture'
import prisma from '@/lib/prisma'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// users.acquisition against the REAL prisma client + live local Postgres (the
// harness/CI runs `prisma migrate deploy` first, which adds the column via
// 20261006120000_user_acquisition). The unit suite mocks prisma, so only this
// proves the JSON column accepts what recordSignup writes and returns it
// intact. PostHog is a TEST DOUBLE here (posthogServerMock): the PostHog wrapper
// pulls in the full env validation, which an integration run does not (and
// must not need to) provide.
vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: vi.fn(async () => true),
    aliasServerDistinctId: vi.fn(async () => true),
    getServerPosthogProjectToken: vi.fn(() => null),
}))

const UNIQUE = `acq-${Date.now()}`
const EMAILS = [
    `signup-acq-itest-a-${UNIQUE}@example.com`,
    `signup-acq-itest-b-${UNIQUE}@example.com`,
]
const ids: string[] = []

async function createUser(email: string): Promise<string> {
    const user = await prisma.user.create({
        data: { email, name: 'Acquisition Itest', emailVerified: true },
    })
    ids.push(user.id)
    return user.id
}

beforeAll(async () => {
    // Fail loudly if the migration did not run, rather than as a vague
    // "column does not exist" from deep inside recordSignup's Sentry path.
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'acquisition'`
    expect(
        columns,
        'users.acquisition missing: run `prisma migrate deploy` first',
    ).toHaveLength(1)
})

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
})

describe('users.acquisition (real Postgres)', () => {
    it('is null for a user created without it (every pre-migration account)', async () => {
        const id = await createUser(EMAILS[0]!)
        const row = await prisma.user.findUniqueOrThrow({ where: { id } })
        expect(row.acquisition).toBeNull()
    })

    it('recordSignup stores the first-touch record plus source/surface/method and reads it back intact', async () => {
        const id = await createUser(EMAILS[1]!)
        const firstTouch = {
            utm_source: 'reddit',
            utm_campaign: 'launch',
            gclid: 'g1',
            landing_path: '/stores/nike',
            captured_at: '2026-10-01T12:00:00.000Z',
        }

        const outcome = await recordSignup({
            user: { id },
            headers: new Headers({
                cookie: `${FIRST_TOUCH_COOKIE_NAME}=${serializeFirstTouchCookieValue(firstTouch)}`,
            }),
            method: 'google',
            surface: 'web',
        })

        expect(outcome.acquisitionSaved).toBe(true)
        const row = await prisma.user.findUniqueOrThrow({ where: { id } })
        expect(row.acquisition).toEqual({
            ...firstTouch,
            source: 'reddit',
            signup_surface: 'web',
            signup_method: 'google',
        })
    })

    it('a signup with no cookie stores { source: "unknown", signup_surface, signup_method }', async () => {
        const id = await createUser(`signup-acq-itest-c-${UNIQUE}@example.com`)
        const outcome = await recordSignup({
            user: { id },
            headers: null,
            method: 'apple',
            surface: 'extension',
        })

        expect(outcome.acquisitionSaved).toBe(true)
        const row = await prisma.user.findUniqueOrThrow({ where: { id } })
        expect(row.acquisition).toEqual({
            source: 'unknown',
            signup_surface: 'extension',
            signup_method: 'apple',
        })
    })

    it('is write-once against real Postgres: a second recordSignup keeps the first record (Prisma.DbNull guard)', async () => {
        const id = await createUser(`signup-acq-itest-d-${UNIQUE}@example.com`)
        const first = await recordSignup({
            user: { id },
            headers: null,
            method: 'email',
            surface: 'web',
        })
        const second = await recordSignup({
            user: { id },
            headers: null,
            method: 'google',
            surface: 'extension',
        })

        expect(first.acquisitionSaved).toBe(true)
        expect(second.acquisitionSaved).toBe(false)
        const row = await prisma.user.findUniqueOrThrow({ where: { id } })
        expect(row.acquisition).toEqual({
            source: 'unknown',
            signup_surface: 'web',
            signup_method: 'email',
        })
    })

    it('reports acquisitionSaved:false (and does not throw) for a user id that does not exist', async () => {
        const outcome = await recordSignup({
            user: { id: 'no-such-user-id' },
            headers: null,
            method: 'email',
            surface: 'web',
        })
        expect(outcome.acquisitionSaved).toBe(false)
        // The event is still attempted: analytics does not depend on the row.
        expect(outcome.eventCaptured).toBe(true)
    })
})
