import { describe, expect, it } from 'vitest'

// T-8622: vitest.config.ts pins TZ=UTC in the main process. This is the proof
// it reached the worker (a shell-exported TZ, or a config regression to
// `test.env`, which threads ignore, would fail here instead of surfacing as a
// date that is off by a day in some unrelated suite).
describe('test runner timezone pin', () => {
    it('runs every suite in UTC', () => {
        expect(process.env.TZ).toBe('UTC')
        expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC')
        expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(0)
        expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(0)
    })

    it('reads local-time getters as UTC', () => {
        const date = new Date('2026-09-24T23:30:00Z')

        expect(date.getHours()).toBe(23)
        expect(date.getDate()).toBe(24)
        expect(date.toString()).toContain('GMT+0000')
    })
})
