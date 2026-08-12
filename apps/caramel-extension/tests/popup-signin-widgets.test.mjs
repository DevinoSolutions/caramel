import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadExtensionSource, loadExtensionSources } from './_load.mjs'

// WXT-migration P0 characterization pins (2026-08-12)
//
// The sign-in prompt's three small widgets, none of them covered by the four
// OAuth suites that share this view. Each is the kind of detail a rewrite
// drops silently because nothing looks broken in a screenshot:
//
//   1. The password show/hide toggle (popup.js:986-1004). It flips the input
//      type AND keeps aria-pressed/aria-label/the two icons in sync — a
//      rewrite that only swaps the type leaves a screen reader announcing
//      "Show password" on a field that is already showing it.
//   2. The Back button (popup.js:880, :972-976, :983-984). It exists ONLY when
//      renderSignInPrompt was handed a function, because `returnView` is what
//      the template branches on; a Back button with nothing behind it would be
//      a dead control, and no Back button at all strands a user who reached
//      sign-in from another view.
//   3. The settings gear is hidden here (popup.js:980-981). It is a shared
//      header element other views turn ON (wireSettingsGear sets display
//      block), so this view must actively turn it back off — index.html's
//      contract is "shown only when the user is logged in".
//
// Harness mirrors popup-oauth-cancel.test.mjs.
let renderSignInPrompt

beforeAll(() => {
    document.body.innerHTML =
        '<div id="loading-container"></div>' +
        '<button id="settingsIcon" style="display:none"></button>' +
        '<div id="auth-container"></div>'

    loadExtensionSource('coupon-constants.generated.js', [])
    loadExtensionSources(
        [
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
        ],
        [],
    )
    globalThis.currentBrowser.tabs.create = () => {}
    window.close = vi.fn()
    ;({ renderSignInPrompt } = loadExtensionSource('popup.js', [
        'renderSignInPrompt',
    ]))
})

beforeEach(() => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
})

const toggle = () => document.getElementById('togglePasswordBtn')
const passwordInput = () => document.getElementById('password')

describe('popup sign-in prompt — password show/hide toggle', () => {
    beforeEach(async () => {
        await renderSignInPrompt()
    })

    it('starts masked, with the button announcing the action it offers', () => {
        expect(passwordInput().type).toBe('password')
        expect(toggle().getAttribute('aria-pressed')).toBe('false')
        expect(toggle().getAttribute('aria-label')).toBe('Show password')
        expect(document.getElementById('eyeIcon').style.display).toBe('')
        expect(document.getElementById('eyeOffIcon').style.display).toBe('none')
    })

    it('reveals the password and flips the accessible state and icons with it', () => {
        toggle().click()

        expect(passwordInput().type).toBe('text')
        expect(toggle().getAttribute('aria-pressed')).toBe('true')
        expect(toggle().getAttribute('aria-label')).toBe('Hide password')
        expect(document.getElementById('eyeIcon').style.display).toBe('none')
        expect(document.getElementById('eyeOffIcon').style.display).toBe('')
    })

    it('masks it again on a second press, back to the exact starting state', () => {
        toggle().click()
        toggle().click()

        expect(passwordInput().type).toBe('password')
        expect(toggle().getAttribute('aria-pressed')).toBe('false')
        expect(toggle().getAttribute('aria-label')).toBe('Show password')
        expect(document.getElementById('eyeIcon').style.display).toBe('')
        expect(document.getElementById('eyeOffIcon').style.display).toBe('none')
    })

    it('does not disturb what the user typed', () => {
        passwordInput().value = 'hunter2'

        toggle().click()

        expect(document.getElementById('password').value).toBe('hunter2')
    })
})

describe('popup sign-in prompt — the Back button', () => {
    it('renders and calls the handler it was given', async () => {
        const back = vi.fn()

        await renderSignInPrompt(back)

        const backBtn = document.getElementById('backBtn')
        expect(
            backBtn,
            'a return view was supplied, so Back must exist',
        ).toBeTruthy()
        backBtn.click()
        expect(back).toHaveBeenCalledTimes(1)
    })

    it('is absent entirely when there is nowhere to go back to', async () => {
        // Both shapes of "no return view": called with nothing (the popup's own
        // top-level sign-in) and called with a non-function, which :880 folds
        // to null rather than wiring a listener that would throw on click.
        for (const backFn of [undefined, null, 'renderCouponsView']) {
            await renderSignInPrompt(backFn)
            expect(
                document.getElementById('backBtn'),
                String(backFn),
            ).toBeNull()
        }
    })

    it('drops a stale Back button when the view is re-rendered without one', async () => {
        await renderSignInPrompt(vi.fn())
        expect(document.getElementById('backBtn')).toBeTruthy()

        await renderSignInPrompt()

        expect(document.getElementById('backBtn')).toBeNull()
    })
})

describe('popup sign-in prompt — the settings gear', () => {
    it('is hidden, even when a previous view turned it on', async () => {
        // wireSettingsGear (popup.js:270) is what leaves it visible; signing
        // out must not strand a gear over a signed-out popup.
        document.getElementById('settingsIcon').style.display = 'block'

        await renderSignInPrompt()

        expect(document.getElementById('settingsIcon').style.display).toBe(
            'none',
        )
    })
})
