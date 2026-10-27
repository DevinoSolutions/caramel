// src/lib/wallClockSchedule.ts
//
// The ONE scheduler for the app's in-process timers (reporter retention, proposal
// retention, email-delivery health). Caramel has no cron and no worker; the
// Next server is the only long-running process, so each job rides an unref'd
// timer started once from instrumentation.ts.
//
// Slots are pinned to the WALL CLOCK (UTC), never to boot. A boot-relative
// setInterval counts from every restart, so when deploys land closer together
// than the interval it never fires at all (2026-10-27: prod restarted every
// 30-40 minutes, the reporter sweep never ran and its Sentry monitor alerted,
// CARAMEL-39 / T-9433; the same latent bug sat in the other two timers,
// T-9436). On the wall clock a restart costs a slot only if the process is down
// at that exact minute.
//
// There is deliberately NO run at boot. A boot within WALL_CLOCK_BOOT_GUARD_MS
// before a slot (or just after it) waits for the NEXT slot, so a crash-looping
// container runs a job at most once per period, never once per restart.
//
// A schedule is a period plus an offset, both in minutes from UTC midnight:
// slots fall at offset, offset + period, offset + 2 * period, ... A period must
// tile the day exactly (it divides 1440, and below an hour it divides 60) and be
// at least MIN_PERIOD_MINUTES, so the boot guard never swallows the slot right
// after a tick (a tick re-arms from "now", which sits on the slot it just ran);
// "every N minutes" means the same slots on every day and the matching Sentry
// crontab (wallClockCrontab) is exact. This file imports nothing, so env.ts can
// validate a period without loading the server.

const MINUTE_MS = 60 * 1000
const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR
/** Shortest supported period: longer than the boot guard plus timer lag. */
const MIN_PERIOD_MINUTES = 5

/**
 * A boot closer than this before a slot waits for the next one instead of
 * running seconds after start (crash-loop guard).
 */
const WALL_CLOCK_BOOT_GUARD_MS = 2 * MINUTE_MS

export interface WallClockSchedule {
    /** Minutes between slots. See isValidWallClockPeriodMinutes. */
    periodMinutes: number
    /**
     * Minutes after UTC midnight of a slot; taken modulo the period, so for a
     * 15 minute period an offset of 23 means :08, :23, :38, :53.
     */
    offsetMinutes: number
}

/** Whole minutes (at least 5) that tile the UTC day: below an hour a divisor of 60, otherwise whole hours dividing 24. */
export function isValidWallClockPeriodMinutes(periodMinutes: number): boolean {
    if (
        !Number.isInteger(periodMinutes) ||
        periodMinutes < MIN_PERIOD_MINUTES
    ) {
        return false
    }
    if (periodMinutes < MINUTES_PER_HOUR) {
        return MINUTES_PER_HOUR % periodMinutes === 0
    }
    return (
        periodMinutes % MINUTES_PER_HOUR === 0 &&
        MINUTES_PER_DAY % periodMinutes === 0
    )
}

function assertValidSchedule(schedule: WallClockSchedule): void {
    if (!isValidWallClockPeriodMinutes(schedule.periodMinutes)) {
        throw new Error(
            `wallClockSchedule: periodMinutes ${schedule.periodMinutes} does not tile the UTC day (at least 5, a divisor of 60 below an hour, otherwise a whole number of hours dividing 24)`,
        )
    }
    if (
        !Number.isInteger(schedule.offsetMinutes) ||
        schedule.offsetMinutes < 0
    ) {
        throw new Error(
            `wallClockSchedule: offsetMinutes ${schedule.offsetMinutes} must be a non-negative integer`,
        )
    }
}

/**
 * Milliseconds from `nowMs` to the next slot that is at least
 * WALL_CLOCK_BOOT_GUARD_MS away. Pure wall-clock arithmetic (no state), so a
 * re-arm after a tick never drifts and a timer firing a few ms off its slot
 * cannot run the same slot twice.
 */
export function msUntilNextWallClockSlot(
    schedule: WallClockSchedule,
    nowMs: number,
): number {
    assertValidSchedule(schedule)
    const periodMs = schedule.periodMinutes * MINUTE_MS
    const offsetMs =
        (schedule.offsetMinutes % schedule.periodMinutes) * MINUTE_MS
    const earliestMs = nowMs + WALL_CLOCK_BOOT_GUARD_MS
    const slotMs =
        Math.ceil((earliestMs - offsetMs) / periodMs) * periodMs + offsetMs
    return slotMs - nowMs
}

/**
 * The crontab expression (UTC) whose fire times are exactly this schedule's
 * slots, for the Sentry monitor of the job the schedule drives.
 */
export function wallClockCrontab(schedule: WallClockSchedule): string {
    assertValidSchedule(schedule)
    const { periodMinutes } = schedule
    const offset = schedule.offsetMinutes % periodMinutes
    if (periodMinutes < MINUTES_PER_HOUR) {
        return offset === 0
            ? `*/${periodMinutes} * * * *`
            : `${offset}-59/${periodMinutes} * * * *`
    }
    const hourStep = periodMinutes / MINUTES_PER_HOUR
    const minute = offset % MINUTES_PER_HOUR
    const startHour = Math.floor(offset / MINUTES_PER_HOUR)
    if (hourStep === 1) return `${minute} * * * *`
    const hours =
        startHour === 0 ? `*/${hourStep}` : `${startHour}-23/${hourStep}`
    return `${minute} ${hours} * * *`
}

/** The Sentry cron monitor config shape the app's jobs use (UTC crontab). */
export interface WallClockMonitorConfig {
    schedule: { type: 'crontab'; value: string }
    timezone: 'UTC'
    /** Minutes after the expected time before a missing check-in counts as missed. */
    checkinMargin: number
    /** Minutes an in_progress check-in may stay open before it counts as failed. */
    maxRuntime: number
    failureIssueThreshold: number
    recoveryThreshold: number
}

/**
 * Monitor config built from the same schedule that drives the timer, so the
 * crontab can never drift from the slots. One miss (a deploy straddling the
 * slot) does not alert; two consecutive misses or errors do.
 */
export function wallClockMonitorConfig(
    schedule: WallClockSchedule,
    options: { checkinMargin: number; maxRuntime: number },
): WallClockMonitorConfig {
    return {
        schedule: { type: 'crontab', value: wallClockCrontab(schedule) },
        timezone: 'UTC',
        checkinMargin: options.checkinMargin,
        maxRuntime: options.maxRuntime,
        failureIssueThreshold: 2,
        recoveryThreshold: 1,
    }
}

/** What a job's start function decided; logged at boot so "is it running?" is never a guess. */
export interface TimerStartDecision {
    enabled: boolean
    reason: string
}

export interface WallClockTimerOptions {
    /** Log prefix, e.g. 'couponReporterRetention'. */
    name: string
    schedule: WallClockSchedule
    /**
     * Runs at each slot. It must report its own failures (the callers check in
     * to a Sentry cron monitor); a rejection here is logged as the last resort.
     */
    onSlot: () => Promise<void>
}

/**
 * Arm the one-shot timer for the next slot; every tick re-arms BEFORE it runs
 * the job, so nothing the job does (a throw, a hang) can end the schedule.
 * Timers are unref'd, so they never hold the process open. Returns the first
 * slot (ISO, UTC) for the boot decision log.
 */
export function startWallClockTimer(options: WallClockTimerOptions): {
    nextSlotAt: string
} {
    assertValidSchedule(options.schedule)
    const arm = (): void => {
        const timer = setTimeout(
            () => {
                arm()
                options.onSlot().catch((error: unknown) => {
                    console.error(
                        `[${options.name}] scheduled run rejected (it must report its own failures)`,
                        error,
                    )
                })
            },
            msUntilNextWallClockSlot(options.schedule, Date.now()),
        )
        // Guarded because a faked timer (vitest) is not always a real Node Timeout.
        if (typeof timer.unref === 'function') timer.unref()
    }
    const now = Date.now()
    arm()
    return {
        nextSlotAt: new Date(
            now + msUntilNextWallClockSlot(options.schedule, now),
        ).toISOString(),
    }
}
