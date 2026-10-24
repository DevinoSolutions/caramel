import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import {
    caramelCopyText,
    hideTestingModal,
    showTestingModal,
    updateTestingModal,
} from '../UI-helpers.js'
import { trustedClick, trustedKey } from './_trusted-events.mjs'

// Characterization suite (T-5446), written BEFORE UI-helpers.js is split into
// modules. It pins the parts of the injected UI no other suite asserts:
//
//   · caramelCopyText — the async clipboard first, the hidden-textarea
//     execCommand fallback second, false when neither works (the popup's
//     coupon list and the result card both rely on that return value);
//   · the testing overlay beyond "it mounts" — its heading and loading block,
//     the dialog semantics, the focus trap, what ✕ / Esc do (cancel flag,
//     persisted run stop, close), what happens when the persisted stop fails,
//     that closing it hands focus back to the page and removes its Esc
//     listener, and that updating a card that is not there is a no-op.

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const stubs = vi.hoisted(() => ({
    cancelRun: null,
    logCalls: [],
}))

vi.mock('../caramel-base.js', async importOriginal => {
    const actual = await importOriginal()
    return {
        ...actual,
        // `currentBrowser` is assigned by initCaramelBase(); a spread would
        // freeze it at undefined, so the live binding is passed through.
        get currentBrowser() {
            return actual.currentBrowser
        },
        log: (...args) => stubs.logCalls.push(args),
    }
})
vi.mock('../dom-utils.js', async importOriginal => ({
    ...(await importOriginal()),
    caramelCancelRun: (...args) => stubs.cancelRun(...args),
}))

const emptyArea = () => ({
    get: (_keys, cb) => cb?.({}),
    set: (_items, cb) => cb?.(),
    remove: (_keys, cb) => cb?.(),
})

const overlay = () => document.getElementById('caramel-testing-overlay')
const overlayRoot = () => overlay()?.shadowRoot ?? null

beforeAll(() => {
    globalThis.chrome = {
        runtime: { getURL: p => p, lastError: undefined },
        storage: { local: emptyArea(), sync: emptyArea() },
    }
    initCaramelBase()
    globalThis.fetch = async relPath => ({
        ok: true,
        text: async () =>
            readFileSync(join(EXT_ROOT, 'public', relPath), 'utf8'),
    })
})

beforeEach(() => {
    // Close through the helper, not by wiping the body: the card's Esc
    // listener lives on `document`, so a card removed any other way would
    // leave it listening for the next test.
    hideTestingModal()
    document.body.innerHTML = ''
    globalThis._caramelCancelled = false
    stubs.logCalls = []
    stubs.cancelRun = async () => {}
})

describe('caramelCopyText', () => {
    let writeText

    afterEach(() => {
        delete navigator.clipboard
        delete document.execCommand
    })

    function withClipboard(impl) {
        writeText = vi.fn(impl)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })
    }

    it('uses the async clipboard when the page allows it, and touches nothing else', async () => {
        withClipboard(async () => {})
        document.execCommand = vi.fn(() => true)

        await expect(caramelCopyText('SAVE10')).resolves.toBe(true)

        expect(writeText).toHaveBeenCalledWith('SAVE10')
        expect(document.execCommand).not.toHaveBeenCalled()
        expect(document.querySelector('textarea')).toBeNull()
    })

    it('falls through to the hidden textarea when the page blocks the clipboard API', async () => {
        withClipboard(async () => {
            throw new Error('NotAllowedError')
        })
        let seen
        document.execCommand = vi.fn(command => {
            const ta = document.querySelector('textarea')
            seen = {
                command,
                value: ta.value,
                readonly: ta.hasAttribute('readonly'),
                position: ta.style.position,
                top: ta.style.top,
                opacity: ta.style.opacity,
            }
            return true
        })

        await expect(caramelCopyText('SAVE10')).resolves.toBe(true)

        expect(seen).toEqual({
            command: 'copy',
            value: 'SAVE10',
            readonly: true,
            position: 'fixed',
            top: '-1000px',
            opacity: '0',
        })
        // The scratch element does not outlive the copy.
        expect(document.querySelector('textarea')).toBeNull()
    })

    it('uses the textarea when there is no clipboard API at all', async () => {
        document.execCommand = vi.fn(() => true)

        await expect(caramelCopyText('CODE')).resolves.toBe(true)

        expect(document.execCommand).toHaveBeenCalledWith('copy')
    })

    it('reports the textarea fallback saying no as false (the card then asks for Ctrl+C)', async () => {
        document.execCommand = vi.fn(() => false)

        await expect(caramelCopyText('CODE')).resolves.toBe(false)
        expect(document.querySelector('textarea')).toBeNull()
    })

    it('reports false, not a throw, when the fallback itself throws', async () => {
        document.execCommand = vi.fn(() => {
            throw new Error('not supported')
        })

        await expect(caramelCopyText('CODE')).resolves.toBe(false)
    })
})

describe('the testing overlay — what it shows', () => {
    it('is headed "Applying Coupons..." with the loading block when given no title', async () => {
        await showTestingModal()

        const root = overlayRoot()
        expect(root.querySelector('h2').textContent).toBe('Applying Coupons...')
        expect(root.querySelector('#caramel-test-status').textContent).toBe(
            'Checking this store for codes…',
        )
        expect(root.querySelector('#caramel-progress-container')).not.toBeNull()
        expect(root.querySelector('#caramel-progress-bar')).not.toBeNull()
    })

    it('uses the title it is given (a resumed run says so)', async () => {
        await showTestingModal('Still checking codes…')

        expect(overlayRoot().querySelector('h2').textContent).toBe(
            'Still checking codes…',
        )
    })

    it('leaves the loading block out when asked for none', async () => {
        await showTestingModal('Just a note', true)

        const root = overlayRoot()
        expect(root.querySelector('h2').textContent).toBe('Just a note')
        expect(root.querySelector('#caramel-test-status')).toBeNull()
        expect(root.querySelector('#caramel-progress-container')).toBeNull()
    })

    it('is a modal dialog named "Applying coupons", with a Stop button', async () => {
        await showTestingModal()

        const modal = overlayRoot().querySelector('#caramel-testing-modal')
        expect(modal.getAttribute('role')).toBe('dialog')
        expect(modal.getAttribute('aria-modal')).toBe('true')
        expect(modal.getAttribute('aria-label')).toBe('Applying coupons')
        const close = overlayRoot().querySelector('#caramel-testing-close')
        expect(close.getAttribute('aria-label')).toBe('Stop')
        expect(close.getAttribute('title')).toBe('Stop')
    })

    it('takes focus itself, not its Stop button', async () => {
        await showTestingModal()

        const root = overlayRoot()
        expect(root.activeElement).toBe(
            root.querySelector('#caramel-testing-modal'),
        )
    })

    it('keeps Tab inside the card', async () => {
        await showTestingModal()
        const root = overlayRoot()
        const modal = root.querySelector('#caramel-testing-modal')

        trustedKey(modal, 'Tab')

        expect(root.activeElement).toBe(
            root.querySelector('#caramel-testing-close'),
        )
    })
})

describe('the testing overlay — progress', () => {
    it('rounds the progress to a whole percent', async () => {
        await showTestingModal()

        await updateTestingModal(1, 3, 'A')

        expect(
            overlayRoot().querySelector('#caramel-progress-bar').style.width,
        ).toBe('33%')
        expect(
            overlayRoot().querySelector('#caramel-test-status').textContent,
        ).toBe('Trying coupon 1 of 3 (A)...')
    })

    it('leaves the bar alone when the total is zero', async () => {
        await showTestingModal()

        await updateTestingModal(0, 0, 'A')

        expect(
            overlayRoot().querySelector('#caramel-progress-bar').style.width,
        ).toBe('')
    })

    it('is a no-op, not an error, when no card is showing', async () => {
        await expect(updateTestingModal(1, 3, 'A')).resolves.toBeUndefined()
        expect(overlay()).toBeNull()
    })
})

describe('the testing overlay — stopping it', () => {
    it("stops the run for good on the shopper's ✕: flag, persisted stop, card gone", async () => {
        const stopped = vi.fn(async () => {})
        stubs.cancelRun = stopped
        await showTestingModal()

        trustedClick(overlayRoot().querySelector('#caramel-testing-close'))

        expect(globalThis._caramelCancelled).toBe(true)
        expect(stopped).toHaveBeenCalledTimes(1)
        expect(overlay()).toBeNull()
    })

    it('stops the run on Esc the same way', async () => {
        const stopped = vi.fn(async () => {})
        stubs.cancelRun = stopped
        await showTestingModal()

        trustedKey(document, 'Escape')

        expect(globalThis._caramelCancelled).toBe(true)
        expect(stopped).toHaveBeenCalledTimes(1)
        expect(overlay()).toBeNull()
    })

    it('ignores every other key', async () => {
        await showTestingModal()

        trustedKey(document, 'Enter')
        trustedKey(document, 'a')

        expect(globalThis._caramelCancelled).toBe(false)
        expect(overlay()).not.toBeNull()
    })

    it('still closes, and says so, when the persisted stop fails', async () => {
        stubs.cancelRun = async () => {
            throw new Error('storage unavailable')
        }
        await showTestingModal()

        trustedClick(overlayRoot().querySelector('#caramel-testing-close'))
        await Promise.resolve()
        await Promise.resolve()

        expect(globalThis._caramelCancelled).toBe(true)
        expect(overlay()).toBeNull()
        expect(stubs.logCalls).toContainEqual([
            'RUN_CANCEL_FAILED',
            { error: 'storage unavailable' },
        ])
    })
})

describe('the testing overlay — closing it', () => {
    it('hands focus back to what the page had focused before it opened', async () => {
        document.body.innerHTML = '<button id="page-button">Checkout</button>'
        const pageButton = document.getElementById('page-button')
        pageButton.focus()
        expect(document.activeElement).toBe(pageButton)
        await showTestingModal()
        expect(document.activeElement).not.toBe(pageButton)

        hideTestingModal()

        expect(overlay()).toBeNull()
        expect(document.activeElement).toBe(pageButton)
    })

    it('stops listening for Esc once it is closed', async () => {
        await showTestingModal()
        hideTestingModal()

        trustedKey(document, 'Escape')

        // A stray Esc on the bare page must not read as a cancel.
        expect(globalThis._caramelCancelled).toBe(false)
    })

    it('is a no-op when there is nothing to close', () => {
        expect(() => hideTestingModal()).not.toThrow()
    })

    it('closes only its own card, not a look-alike the page made', async () => {
        const lookAlike = document.createElement('div')
        lookAlike.id = 'caramel-testing-overlay'
        document.body.appendChild(lookAlike)

        hideTestingModal()

        expect(document.body.contains(lookAlike)).toBe(true)
    })
})
