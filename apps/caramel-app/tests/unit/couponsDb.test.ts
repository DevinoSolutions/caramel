import { beforeEach, describe, expect, it, vi } from 'vitest'

// F-011 — pins the options object the `postgres` client is constructed with
// BEFORE adding `connection.application_name` (coarse cross-hop correlation:
// attributes coupons-DB queries to this app in pg_stat_activity/DB logs —
// see PLAN-F-011.md §Approach "Trace correlation"). Distinct from
// couponsDb-schemas.test.ts, which pins the zod row schemas, not client
// construction. Mocks the `postgres` module itself so no real connection is
// attempted; `couponsSql` is lazy (porsager postgres.js only opens a socket
// on first query), so importing the module is safe either way.
// Separate vi.hoisted calls (tag first) so the pure tagged-template stub
// lives at true module scope — it captures nothing, so it must not be
// recreated inside postgresMock's implementation on every call.
const tag = vi.hoisted(() => () => Promise.resolve([]))
const { postgresMock } = vi.hoisted(() => ({
    postgresMock: vi.fn(
        (_connectionString: string, _options: Record<string, unknown>) => tag,
    ),
}))
vi.mock('postgres', () => ({ default: postgresMock }))

beforeEach(() => {
    postgresMock.mockClear()
    vi.resetModules()
    // couponsDb.ts caches its client on `globalThis` across hot-reloads
    // (dev-mode behavior, NODE_ENV !== 'production') — clear it too so a
    // re-import doesn't short-circuit the postgres(...) call this test
    // asserts against.
    delete (globalThis as Record<string, unknown>).couponsSql
})

describe('couponsSql client construction (F-011 pin)', () => {
    it('constructs the postgres client with COUPONS_DATABASE_URL and the current pool options', async () => {
        const { couponsSql } = await import('@/lib/couponsDb')
        expect(couponsSql).toBeDefined()

        expect(postgresMock).toHaveBeenCalledTimes(1)
        const [connectionString, options] = postgresMock.mock.calls[0]
        expect(typeof connectionString).toBe('string')
        expect(options).toMatchObject({
            max: 10,
            idle_timeout: 20,
            connect_timeout: 10,
            prepare: false,
        })
    })

    it('sets connection.application_name to "caramel-app" (F-011 coarse cross-hop correlation)', async () => {
        const { couponsSql } = await import('@/lib/couponsDb')
        expect(couponsSql).toBeDefined()

        const [, options] = postgresMock.mock.calls[0]
        expect(options.connection).toEqual({ application_name: 'caramel-app' })
    })
})
