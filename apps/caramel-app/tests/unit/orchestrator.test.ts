import {
    DEFAULT_MAX_DISMISSALS,
    DEFAULT_SNOOZE_MS,
    isDismissedForGood,
    isSnoozed,
    pickPrompt,
    PROMPT_PRIORITY,
    type PromptContext,
    type PromptHistory,
    type PromptRegistration,
} from '@/lib/prompts/orchestrator'
import { describe, expect, it } from 'vitest'

// Fleet growth-prompts spec §B: one prompt at a time, fleet priority order,
// a free kill switch every prompt honours, never two in one session.

const NOW = 1_800_000_000_000

const baseContext: PromptContext = {
    now: NOW,
    surface: 'web',
    platform: 'windows',
    browser: 'chrome',
    visits: 2,
    promptsEnabled: true,
    shownThisSession: false,
    pathname: '/',
    signedIn: false,
    hasExtensionActivity: null,
}

const fresh: PromptHistory = { lastShownAt: null, dismissals: 0 }
const historyFor = () => fresh

function always(id: PromptRegistration['id']): PromptRegistration {
    return { id, decide: () => ({ show: true }) }
}

function never(id: PromptRegistration['id']): PromptRegistration {
    return { id, decide: () => ({ show: false, reason: 'test' }) }
}

describe('pickPrompt', () => {
    it('returns null when nothing is registered', () => {
        expect(pickPrompt([], baseContext, historyFor)).toBeNull()
    })

    it('picks the highest-priority prompt whose policy says yes, whatever the registration order', () => {
        const pick = pickPrompt(
            [always('promo'), always('cross_app'), always('install_extension')],
            baseContext,
            historyFor,
        )
        expect(pick?.id).toBe('install_extension')
    })

    it('falls through a prompt whose policy says no', () => {
        const pick = pickPrompt(
            [never('install_extension'), always('cross_app')],
            baseContext,
            historyFor,
        )
        expect(pick?.id).toBe('cross_app')
    })

    it('shows nothing when the kill switch is off', () => {
        expect(
            pickPrompt(
                [always('install_extension'), always('promo')],
                { ...baseContext, promptsEnabled: false },
                historyFor,
            ),
        ).toBeNull()
    })

    it('shows nothing once a prompt has been shown this session', () => {
        // "Double prompts is bad" — the owner's rule, verbatim.
        expect(
            pickPrompt(
                [always('install_extension')],
                { ...baseContext, shownThisSession: true },
                historyFor,
            ),
        ).toBeNull()
    })

    it('waits for the surface to resolve rather than guessing web', () => {
        expect(
            pickPrompt(
                [always('install_extension')],
                { ...baseContext, surface: 'unknown' },
                historyFor,
            ),
        ).toBeNull()
    })

    it('lets a legally required prompt through the kill switch and the session cap', () => {
        const consent: PromptRegistration = {
            ...always('cookie_consent'),
            exemptFromKillSwitch: true,
        }
        const pick = pickPrompt(
            [consent, always('install_extension')],
            {
                ...baseContext,
                promptsEnabled: false,
                shownThisSession: true,
                surface: 'unknown',
            },
            historyFor,
        )
        expect(pick?.id).toBe('cookie_consent')
    })

    it('hands each policy its own history', () => {
        const seen: string[] = []
        const histories: Record<string, PromptHistory> = {
            install_extension: { lastShownAt: 1, dismissals: 9 },
            promo: { lastShownAt: 2, dismissals: 0 },
        }
        pickPrompt(
            [
                {
                    id: 'install_extension',
                    decide: (_c, h) => {
                        seen.push(`install:${h.dismissals}`)
                        return { show: false, reason: 'test' }
                    },
                },
                {
                    id: 'promo',
                    decide: (_c, h) => {
                        seen.push(`promo:${h.dismissals}`)
                        return { show: true }
                    },
                },
            ],
            baseContext,
            id => histories[id] ?? fresh,
        )
        expect(seen).toEqual(['install:9', 'promo:0'])
    })

    it('refuses a prompt registered twice', () => {
        expect(() =>
            pickPrompt(
                [always('promo'), always('promo')],
                baseContext,
                historyFor,
            ),
        ).toThrow(/registered twice/)
    })

    it('keeps the fleet order: consent, install, notifications, AI tools, cross-app, promos', () => {
        expect([...PROMPT_PRIORITY]).toEqual([
            'cookie_consent',
            'install_extension',
            'enable_notifications',
            'ai_tools',
            'cross_app',
            'promo',
        ])
    })
})

describe('caps helpers', () => {
    it('snoozes for 7 days after a showing by default', () => {
        expect(DEFAULT_SNOOZE_MS).toBe(7 * 24 * 60 * 60 * 1000)
        expect(isSnoozed({ lastShownAt: NOW - 1000, dismissals: 0 }, NOW)).toBe(
            true,
        )
        expect(
            isSnoozed(
                { lastShownAt: NOW - DEFAULT_SNOOZE_MS, dismissals: 0 },
                NOW,
            ),
        ).toBe(false)
        expect(isSnoozed(fresh, NOW)).toBe(false)
    })

    it('stops after three dismissals by default', () => {
        expect(DEFAULT_MAX_DISMISSALS).toBe(3)
        expect(isDismissedForGood({ lastShownAt: null, dismissals: 2 })).toBe(
            false,
        )
        expect(isDismissedForGood({ lastShownAt: null, dismissals: 3 })).toBe(
            true,
        )
    })
})
