// src/lib/prompts/promptStorage.ts
//
// The persistence behind the growth-prompt orchestrator: per-prompt cooldown
// and dismissal count (localStorage — an answer about the offer itself), the
// once-per-session slot (sessionStorage — per tab, dies with it), the visit
// counter the "2nd visit" rule reads, and the local mirror of the Settings
// kill switch for signed-out visitors.
//
// Key names follow the fleet convention `<app>_prompt_<id>_*`. Modelled on
// uNotes' leaveIntentCaps.ts, including its one non-negotiable: every storage
// access is wrapped, because a browser set to block site data THROWS rather
// than answering null, and the failure mode has to be "the page keeps
// working" — but every catch WARNS, because a cap that cannot be read or
// written is exactly why a prompt someone already refused would come back,
// and a silent catch sends whoever investigates that to the wrong file.
import type { PromptHistory, PromptId } from './orchestrator'

/** The slice of `Storage` these need. */
export type CapStorage = {
    getItem(_key: string): string | null
    setItem(_key: string, _value: string): void
}

export const PROMPT_SESSION_SHOWN_KEY = 'caramel_prompt_session_shown'
export const VISITS_KEY = 'caramel_visits'
export const VISIT_COUNTED_SESSION_KEY = 'caramel_visit_counted'
export const PROMPTS_ENABLED_KEY = 'caramel_prompts_enabled'

export function lastShownKey(id: PromptId): string {
    return `caramel_prompt_${id}_last_shown_at`
}

export function dismissalsKey(id: PromptId): string {
    return `caramel_prompt_${id}_dismissals`
}

function readItem(storage: CapStorage | undefined, key: string): string | null {
    if (!storage) return null
    try {
        return storage.getItem(key)
    } catch (error) {
        console.warn(
            `[growth] could not read prompt state "${key}" — a prompt may be shown again`,
            error,
        )
        return null
    }
}

function writeItem(
    storage: CapStorage | undefined,
    key: string,
    value: string,
): void {
    if (!storage) return
    try {
        storage.setItem(key, value)
    } catch (error) {
        console.warn(
            `[growth] could not record prompt state "${key}" — a prompt may be shown again`,
            error,
        )
    }
}

function readPositiveInt(raw: string | null): number {
    const parsed = raw ? Number.parseInt(raw, 10) : 0
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function readPromptHistory(
    storage: CapStorage | undefined,
    id: PromptId,
): PromptHistory {
    const lastShownRaw = readItem(storage, lastShownKey(id))
    const lastShown = lastShownRaw ? Number.parseInt(lastShownRaw, 10) : NaN
    return {
        lastShownAt: Number.isFinite(lastShown) ? lastShown : null,
        dismissals: readPositiveInt(readItem(storage, dismissalsKey(id))),
    }
}

export function wasAnyPromptShownThisSession(
    storage: CapStorage | undefined,
): boolean {
    return readItem(storage, PROMPT_SESSION_SHOWN_KEY) === '1'
}

/**
 * Stamps BOTH the session slot and the prompt's cooldown. Called before the
 * prompt renders (never after), so a render that throws or a tab closed
 * mid-animation still counts as shown — the spec's "shown-stamp written
 * before render".
 */
export function markPromptShown(
    stores: {
        session: CapStorage | undefined
        local: CapStorage | undefined
    },
    id: PromptId,
    now: number,
): void {
    writeItem(stores.session, PROMPT_SESSION_SHOWN_KEY, '1')
    writeItem(stores.local, lastShownKey(id), String(now))
}

/** Records a refusal and answers with the running total. */
export function recordPromptDismissed(
    storage: CapStorage | undefined,
    id: PromptId,
): number {
    const next = readPromptHistory(storage, id).dismissals + 1
    writeItem(storage, dismissalsKey(id), String(next))
    return next
}

/**
 * The visit number for this session, counting each browser session once
 * (first call in a session increments, later calls read). A visitor who has
 * never been here gets 1.
 */
export function countVisit(stores: {
    session: CapStorage | undefined
    local: CapStorage | undefined
}): number {
    const current = readPositiveInt(readItem(stores.local, VISITS_KEY))
    if (readItem(stores.session, VISIT_COUNTED_SESSION_KEY) === '1') {
        return Math.max(current, 1)
    }
    const next = current + 1
    writeItem(stores.local, VISITS_KEY, String(next))
    writeItem(stores.session, VISIT_COUNTED_SESSION_KEY, '1')
    return next
}

/** The local mirror of Settings > "Show tips and prompts"; null = never set. */
export function readPromptsEnabled(
    storage: CapStorage | undefined,
): boolean | null {
    const raw = readItem(storage, PROMPTS_ENABLED_KEY)
    if (raw === '1') return true
    if (raw === '0') return false
    return null
}

export function writePromptsEnabled(
    storage: CapStorage | undefined,
    enabled: boolean,
): void {
    writeItem(storage, PROMPTS_ENABLED_KEY, enabled ? '1' : '0')
}
