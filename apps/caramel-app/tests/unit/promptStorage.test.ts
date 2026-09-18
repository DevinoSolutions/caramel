import {
    countVisit,
    dismissalsKey,
    lastShownKey,
    markPromptShown,
    PROMPT_SESSION_SHOWN_KEY,
    readPromptHistory,
    readPromptsEnabled,
    recordPromptDismissed,
    wasAnyPromptShownThisSession,
    writePromptsEnabled,
    type CapStorage,
} from '@/lib/prompts/promptStorage'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The caps are the feature: a prompt that reappears on every page is an ad.
// Pinned over a fake Storage so the rules are provable without a browser.

function memoryStorage(): CapStorage & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return {
        data,
        getItem: key => data.get(key) ?? null,
        setItem: (key, value) => {
            data.set(key, value)
        },
    }
}

const throwingStorage: CapStorage = {
    getItem: () => {
        throw new Error('site data blocked')
    },
    setItem: () => {
        throw new Error('site data blocked')
    },
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('prompt history', () => {
    it('namespaces keys per app and prompt', () => {
        expect(lastShownKey('install_extension')).toBe(
            'caramel_prompt_install_extension_last_shown_at',
        )
        expect(dismissalsKey('cross_app')).toBe(
            'caramel_prompt_cross_app_dismissals',
        )
    })

    it('reads an empty history as never shown, never dismissed', () => {
        expect(readPromptHistory(memoryStorage(), 'promo')).toEqual({
            lastShownAt: null,
            dismissals: 0,
        })
    })

    it('stamps the session slot AND the cooldown when a prompt is shown', () => {
        const session = memoryStorage()
        const local = memoryStorage()
        markPromptShown({ session, local }, 'install_extension', 1234)

        expect(wasAnyPromptShownThisSession(session)).toBe(true)
        expect(session.data.get(PROMPT_SESSION_SHOWN_KEY)).toBe('1')
        expect(readPromptHistory(local, 'install_extension').lastShownAt).toBe(
            1234,
        )
    })

    it('counts dismissals and answers with the running total', () => {
        const local = memoryStorage()
        expect(recordPromptDismissed(local, 'promo')).toBe(1)
        expect(recordPromptDismissed(local, 'promo')).toBe(2)
        expect(readPromptHistory(local, 'promo').dismissals).toBe(2)
    })

    it('treats garbage as empty rather than throwing', () => {
        const local = memoryStorage()
        local.setItem(lastShownKey('promo'), 'yesterday')
        local.setItem(dismissalsKey('promo'), '-4')
        expect(readPromptHistory(local, 'promo')).toEqual({
            lastShownAt: null,
            dismissals: 0,
        })
    })
})

describe('visits', () => {
    it('counts the first visit as 1 and each new session once', () => {
        const local = memoryStorage()
        const firstSession = memoryStorage()
        expect(countVisit({ session: firstSession, local })).toBe(1)
        // Same session, another page: still visit 1.
        expect(countVisit({ session: firstSession, local })).toBe(1)

        const secondSession = memoryStorage()
        expect(countVisit({ session: secondSession, local })).toBe(2)
    })
})

describe('kill switch mirror', () => {
    it('is null until the user has chosen', () => {
        expect(readPromptsEnabled(memoryStorage())).toBeNull()
    })

    it('round-trips both answers', () => {
        const local = memoryStorage()
        writePromptsEnabled(local, false)
        expect(readPromptsEnabled(local)).toBe(false)
        writePromptsEnabled(local, true)
        expect(readPromptsEnabled(local)).toBe(true)
    })
})

describe('blocked site data', () => {
    it('keeps working and WARNS when storage throws', () => {
        // A browser set to block site data throws on access. The page must
        // keep working, and the failure must be visible — it is the reason a
        // prompt someone refused could come back.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        expect(readPromptHistory(throwingStorage, 'promo')).toEqual({
            lastShownAt: null,
            dismissals: 0,
        })
        markPromptShown(
            { session: throwingStorage, local: throwingStorage },
            'promo',
            1,
        )
        expect(
            countVisit({ session: throwingStorage, local: throwingStorage }),
        ).toBe(1)

        expect(warn).toHaveBeenCalled()
    })

    it('treats a missing storage object as empty without warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        expect(readPromptHistory(undefined, 'promo').dismissals).toBe(0)
        expect(warn).not.toHaveBeenCalled()
    })
})
