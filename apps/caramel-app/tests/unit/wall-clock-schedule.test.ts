import {
    isValidWallClockPeriodMinutes,
    msUntilNextWallClockSlot,
    startWallClockTimer,
    wallClockCrontab,
    wallClockMonitorConfig,
    type WallClockSchedule,
} from '@/lib/wallClockSchedule'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The one scheduler behind the reporter sweep, the proposal sweep and the
// email-delivery health check (wallClockSchedule.ts). Slots sit on the UTC wall
// clock, never on boot: a boot-relative interval starved every one of these
// timers when deploys were closer together than the interval (CARAMEL-39 /
// T-9433, T-9436). Time is fixed with fake timers + vi.setSystemTime.

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY_MS = 24 * HOUR
const HOURLY_AT_07: WallClockSchedule = { periodMinutes: 60, offsetMinutes: 7 }
const SIX_HOURLY_AT_37: WallClockSchedule = {
    periodMinutes: 360,
    offsetMinutes: 37,
}
const utc = (time: string) => Date.parse(`2026-10-27T${time}Z`)
const NEXT_DAY_00_37 = Date.parse('2026-10-28T00:37:00Z')

describe('isValidWallClockPeriodMinutes', () => {
    it.each([5, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440])(
        '%i minutes tiles the UTC day',
        period => {
            expect(isValidWallClockPeriodMinutes(period)).toBe(true)
        },
    )

    it.each([0, 1, 2, 3, 4, -60, 7, 45, 90, 150, 600, 2880, 1.5, Number.NaN])(
        '%s minutes does not',
        period => {
            expect(isValidWallClockPeriodMinutes(period)).toBe(false)
        },
    )
})

describe('msUntilNextWallClockSlot', () => {
    it.each([
        ['10:00:00', '10:07:00'],
        ['10:04:59.999', '10:07:00'],
        // Exactly the 2 minute boot guard away still takes the slot.
        ['10:05:00', '10:07:00'],
        ['10:05:00.001', '11:07:00'],
        ['10:06:59.999', '11:07:00'],
        // A timer firing a few ms off its slot must not run the same slot twice.
        ['10:07:00', '11:07:00'],
        ['10:07:00.005', '11:07:00'],
        ['10:59:59.999', '11:07:00'],
    ])('hourly at :07: at %s the next slot is %s', (now, slot) => {
        const nowMs = utc(now)
        expect(nowMs + msUntilNextWallClockSlot(HOURLY_AT_07, nowMs)).toBe(
            utc(slot),
        )
    })

    it.each([
        ['00:00:00', utc('00:37:00')],
        ['00:36:00', utc('06:37:00')],
        ['06:37:00', utc('12:37:00')],
        ['12:00:00', utc('12:37:00')],
        ['18:40:00', NEXT_DAY_00_37],
        ['23:59:59', NEXT_DAY_00_37],
    ])('every 6 hours at 00:37: at %s the next slot is %i', (now, slotMs) => {
        const nowMs = utc(now)
        expect(nowMs + msUntilNextWallClockSlot(SIX_HOURLY_AT_37, nowMs)).toBe(
            slotMs,
        )
    })

    it('takes the offset modulo the period: 15 minutes at offset 23 is :08 :23 :38 :53', () => {
        const schedule = { periodMinutes: 15, offsetMinutes: 23 }
        const minutes: number[] = []
        let now = utc('10:00:00')
        for (let i = 0; i < 5; i++) {
            now += msUntilNextWallClockSlot(schedule, now)
            minutes.push(new Date(now).getUTCMinutes())
        }
        expect(minutes).toEqual([8, 23, 38, 53, 8])
    })

    it('throws on a schedule that does not tile the day', () => {
        expect(() =>
            msUntilNextWallClockSlot(
                { periodMinutes: 45, offsetMinutes: 0 },
                0,
            ),
        ).toThrow(/does not tile the UTC day/)
        expect(() =>
            msUntilNextWallClockSlot(
                { periodMinutes: 60, offsetMinutes: -1 },
                0,
            ),
        ).toThrow(/non-negative integer/)
    })
})

describe('wallClockCrontab', () => {
    it.each([
        [{ periodMinutes: 60, offsetMinutes: 7 }, '7 * * * *'],
        [{ periodMinutes: 60, offsetMinutes: 67 }, '7 * * * *'],
        [{ periodMinutes: 360, offsetMinutes: 37 }, '37 */6 * * *'],
        [{ periodMinutes: 360, offsetMinutes: 97 }, '37 1-23/6 * * *'],
        [{ periodMinutes: 120, offsetMinutes: 5 }, '5 */2 * * *'],
        [{ periodMinutes: 15, offsetMinutes: 23 }, '8-59/15 * * * *'],
        [{ periodMinutes: 15, offsetMinutes: 30 }, '*/15 * * * *'],
    ])('%j is %s', (schedule, crontab) => {
        expect(wallClockCrontab(schedule)).toBe(crontab)
    })

    // The invariant that matters: the crontab Sentry expects fires at exactly
    // the minutes the timer fires at. A tiny matcher for the forms the helper
    // emits (`m`, `*/n`, `m-59/n`, hours `*`, `*/n`, `a-23/n`) is checked
    // against the timer over every valid period and a spread of offsets.
    function cronFieldMatches(field: string, value: number): boolean {
        if (field === '*') return true
        const [range, step] = field.split('/') as [string, string | undefined]
        if (step === undefined) return Number(range) === value
        const start = range === '*' ? 0 : Number(range.split('-')[0])
        return value >= start && (value - start) % Number(step) === 0
    }
    function cronFires(crontab: string, ms: number): boolean {
        const [minute, hour] = crontab.split(' ') as [string, string]
        const at = new Date(ms)
        return (
            cronFieldMatches(minute, at.getUTCMinutes()) &&
            cronFieldMatches(hour, at.getUTCHours())
        )
    }

    it('fires on exactly the timer slots, for every valid period and a spread of offsets', () => {
        const dayStart = utc('00:00:00')
        const dayEnd = dayStart + DAY_MS
        const periods = Array.from({ length: 1440 }, (_, i) => i + 1).filter(
            isValidWallClockPeriodMinutes,
        )
        for (const periodMinutes of periods) {
            for (const offsetMinutes of [0, 7, 23, 37, 59, 61, 97, 500, 1439]) {
                const schedule = { periodMinutes, offsetMinutes }
                const crontab = wallClockCrontab(schedule)

                // The timer's own slots across the day.
                const timerSlots: number[] = []
                let now = dayStart - 2 * MINUTE
                for (;;) {
                    now += msUntilNextWallClockSlot(schedule, now)
                    if (now >= dayEnd) break
                    if (now >= dayStart) timerSlots.push(now)
                }

                // Every minute of the day the crontab fires.
                const cronSlots: number[] = []
                for (let t = dayStart; t < dayEnd; t += MINUTE) {
                    if (cronFires(crontab, t)) cronSlots.push(t)
                }

                expect(
                    cronSlots,
                    `${JSON.stringify(schedule)} -> ${crontab}`,
                ).toEqual(timerSlots)
            }
        }
    })
})

describe('wallClockMonitorConfig', () => {
    it('builds a UTC crontab monitor from the schedule with the standard thresholds', () => {
        expect(
            wallClockMonitorConfig(HOURLY_AT_07, {
                checkinMargin: 30,
                maxRuntime: 3,
            }),
        ).toEqual({
            schedule: { type: 'crontab', value: '7 * * * *' },
            timezone: 'UTC',
            checkinMargin: 30,
            maxRuntime: 3,
            failureIssueThreshold: 2,
            recoveryThreshold: 1,
        })
    })
})

describe('startWallClockTimer', () => {
    const onSlot = vi.fn(async (): Promise<void> => {})

    beforeEach(() => {
        onSlot.mockReset()
        onSlot.mockResolvedValue(undefined)
        vi.useFakeTimers()
        vi.setSystemTime(new Date(utc('10:50:00')))
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('returns the first slot and never runs at boot (a :50 boot runs at :07, not 60 minutes later)', () => {
        const { nextSlotAt } = startWallClockTimer({
            name: 'test',
            schedule: HOURLY_AT_07,
            onSlot,
        })

        expect(nextSlotAt).toBe('2026-10-27T11:07:00.000Z')
        expect(onSlot).not.toHaveBeenCalled()
        vi.advanceTimersByTime(17 * MINUTE - 1)
        expect(onSlot).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(onSlot).toHaveBeenCalledTimes(1)
        expect(Date.now()).toBe(utc('11:07:00'))
    })

    it('a boot inside the 2 minute guard before the slot skips to the next slot', () => {
        vi.setSystemTime(new Date(utc('10:06:00')))
        const { nextSlotAt } = startWallClockTimer({
            name: 'test',
            schedule: HOURLY_AT_07,
            onSlot,
        })

        expect(nextSlotAt).toBe('2026-10-27T11:07:00.000Z')
        vi.advanceTimersByTime(5 * MINUTE)
        expect(onSlot).not.toHaveBeenCalled()
    })

    it('consecutive ticks are exactly one period apart', async () => {
        const times: number[] = []
        onSlot.mockImplementation(async () => {
            times.push(Date.now())
        })
        startWallClockTimer({
            name: 'test',
            schedule: SIX_HOURLY_AT_37,
            onSlot,
        })

        await vi.advanceTimersByTimeAsync(24 * HOUR)

        expect(times).toEqual([
            utc('12:37:00'),
            utc('18:37:00'),
            NEXT_DAY_00_37,
            NEXT_DAY_00_37 + 6 * HOUR,
        ])
    })

    it('re-arms BEFORE the job runs: a job that never settles does not end the schedule', async () => {
        onSlot.mockImplementationOnce(() => new Promise<void>(() => {}))
        startWallClockTimer({ name: 'test', schedule: HOURLY_AT_07, onSlot })

        await vi.advanceTimersByTimeAsync(17 * MINUTE)
        expect(onSlot).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(HOUR)

        expect(onSlot).toHaveBeenCalledTimes(2)
    })

    it('a job that rejects is logged loudly and the schedule keeps going', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        onSlot.mockRejectedValueOnce(new Error('boom'))
        startWallClockTimer({ name: 'test', schedule: HOURLY_AT_07, onSlot })

        await vi.advanceTimersByTimeAsync(17 * MINUTE + HOUR)

        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('[test] scheduled run rejected'),
            expect.any(Error),
        )
        expect(onSlot).toHaveBeenCalledTimes(2)
    })

    it('keeps exactly one timer armed', () => {
        startWallClockTimer({ name: 'test', schedule: HOURLY_AT_07, onSlot })
        expect(vi.getTimerCount()).toBe(1)
        vi.advanceTimersByTime(17 * MINUTE)
        expect(vi.getTimerCount()).toBe(1)
    })

    it('throws at start on a schedule that does not tile the day, arming nothing', () => {
        expect(() =>
            startWallClockTimer({
                name: 'test',
                schedule: { periodMinutes: 45, offsetMinutes: 0 },
                onSlot,
            }),
        ).toThrow(/does not tile the UTC day/)
        expect(vi.getTimerCount()).toBe(0)
    })
})
