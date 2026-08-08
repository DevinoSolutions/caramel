import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// Dismissing the prompt used to remove the host and record nothing — which
// failed the user twice over.
//
// Same page: removing the host is ITSELF a childList mutation inside the
// subtree store-detect.js's re-detection observer watches, so the observer
// woke, saw the coupon box still visible and no prompt, and put it straight
// back. Two agents measured it independently on 2026-08-05: gone at ~40ms,
// BACK at 116-438ms on lookfantastic.com at phone size, three runs; a second
// dismissal stuck only because the observer had by then disconnected itself.
// A user taps the ✕, watches it reappear, and concludes the button is broken.
//
// Across reloads: nothing was written anywhere, so it returned on every load.
//
// One flag closes both, because insertCaramelPrompt is the only door a prompt
// comes through. sessionStorage scopes it to this tab and origin — "not now"
// for this visit, not a silent permanent opt-out. The permanent version is
// already explicit: "Pause on this site" in the popup settings.

let caramelPromptDismissedHere
let caramelMarkPromptDismissed
let insertCaramelPrompt

beforeAll(() => {
    ;({
        caramelPromptDismissedHere,
        caramelMarkPromptDismissed,
        insertCaramelPrompt,
    } = loadExtensionSources(
        ['caramel-base.js', 'dom-utils.js', 'UI-helpers.js'],
        [
            'caramelPromptDismissedHere',
            'caramelMarkPromptDismissed',
            'insertCaramelPrompt',
        ],
    ))
})

beforeEach(() => {
    sessionStorage.clear()
    document.body.innerHTML = ''
    // The prompt is otherwise allowed: this suite is about the dismissal gate,
    // not the settings gate.
    globalThis.caramelPromptAllowed = async () => true
})

describe('prompt dismissal is remembered', () => {
    it('starts undismissed, so a first visit still gets the prompt', () => {
        expect(caramelPromptDismissedHere()).toBe(false)
    })

    it('remembers a dismissal', () => {
        caramelMarkPromptDismissed()
        expect(caramelPromptDismissedHere()).toBe(true)
    })

    it('inserts the prompt normally when nothing was dismissed', async () => {
        // Guards the guard. Without this control the assertion below would
        // pass for the wrong reason if the prompt simply never rendered here.
        await insertCaramelPrompt({ domain: 'example.com' })
        expect(document.getElementById('caramel-small-prompt')).not.toBeNull()
    })

    it('refuses to re-insert the prompt after a dismissal', async () => {
        // This is the fix for BOTH reported failures: the observer's re-insert
        // and the post-reload re-insert go through this same function.
        caramelMarkPromptDismissed()
        await insertCaramelPrompt({ domain: 'example.com' })
        expect(document.getElementById('caramel-small-prompt')).toBeNull()
    })

    it('does not leak the dismissal to another origin', () => {
        // sessionStorage is per-origin, so pausing one store must not silence
        // the prompt on the next store the shopper visits.
        caramelMarkPromptDismissed()
        sessionStorage.clear() // stand-in for a different origin's storage
        expect(caramelPromptDismissedHere()).toBe(false)
    })

    it('shows the prompt rather than hiding it forever when storage is blocked', () => {
        // Some checkouts partition storage. Failing closed would silence the
        // product on exactly those stores, on a flag we cannot even read.
        const getItem = vi
            .spyOn(Storage.prototype, 'getItem')
            .mockImplementation(() => {
                throw new Error('storage blocked')
            })
        try {
            expect(caramelPromptDismissedHere()).toBe(false)
        } finally {
            getItem.mockRestore()
        }
    })

    it('does not throw when a dismissal cannot be recorded', () => {
        const setItem = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new Error('storage blocked')
            })
        try {
            expect(() => caramelMarkPromptDismissed()).not.toThrow()
        } finally {
            setItem.mockRestore()
        }
    })
})
