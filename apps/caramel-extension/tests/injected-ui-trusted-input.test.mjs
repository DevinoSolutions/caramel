import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/* Our UI sits in the store's page, and the page can reach it: the prompt's host
 * is in the page's DOM, its shadow root is open, and the testing and final
 * cards listen for keys on the page's document. A script there could start a
 * run the shopper never asked for (which submits codes into their cart), stop
 * one, or answer a card for them. Every control acts only on the shopper's own
 * input: an event a script makes, with .click() or dispatchEvent, is never
 * trusted, and does nothing.
 */

const started = vi.fn(async () => {})
vi.mock('../coupon-runner.js', async importOriginal => ({
    ...(await importOriginal()),
    startApplyingCoupons: (...a) => started(...a),
}))

const { initCaramelBase } = await import('../caramel-base.js')
const { insertCaramelPrompt, showFinalModal, showTestingModal } = await import(
    '../UI-helpers.js'
)
const { dispatchTrusted, trustedClick, trustedKey } = await import(
    './_trusted-events.mjs'
)

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const emptyArea = () => ({
    get: (_keys, cb) => cb?.({}),
    set: (_items, cb) => cb?.(),
    remove: (_keys, cb) => cb?.(),
})
const messages = []

beforeAll(() => {
    globalThis.chrome = {
        runtime: {
            getURL: p => p,
            lastError: undefined,
            sendMessage: (message, cb) => {
                messages.push(message)
                cb?.({})
            },
        },
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
    document.body.innerHTML = ''
    globalThis._caramelCancelled = false
    started.mockClear()
    messages.length = 0
})

// Everything a page script can do to reach a control.
const pageClicks = el => {
    el.click()
    el.dispatchEvent(
        new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            composed: true,
        }),
    )
}
const pageKey = (target, key) =>
    target.dispatchEvent(
        new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
            composed: true,
        }),
    )
const settle = () => new Promise(r => setTimeout(r, 0))

describe('the prompt', () => {
    const prompt = () => document.getElementById('caramel-small-prompt')

    it('is not started by a page script', async () => {
        await insertCaramelPrompt({ domain: 'example.com' })

        pageClicks(prompt())
        pageClicks(prompt().shadowRoot.querySelector('.cm-prompt'))
        pageKey(prompt(), 'Enter')
        pageKey(prompt(), ' ')
        await settle()

        expect(started).not.toHaveBeenCalled()
        expect(prompt()).not.toBeNull()
    })

    it('starts on the shopper’s click, and on their Enter', async () => {
        await insertCaramelPrompt({ domain: 'example.com' })
        trustedClick(prompt())
        await settle()
        expect(started).toHaveBeenCalledTimes(1)

        document.body.innerHTML = ''
        await insertCaramelPrompt({ domain: 'example.com' })
        prompt().focus()
        trustedKey(prompt(), 'Enter')
        await settle()
        expect(started).toHaveBeenCalledTimes(2)
    })

    it('is not dismissed by a page script, and its × starts nothing', async () => {
        await insertCaramelPrompt({ domain: 'example.com' })
        const close = prompt().shadowRoot.querySelector('#caramel-close-btn')

        pageClicks(close)
        await settle()
        expect(prompt()).not.toBeNull()
        expect(started).not.toHaveBeenCalled()

        trustedClick(close)
        await settle()
        expect(prompt()).toBeNull()
        expect(started).not.toHaveBeenCalled()
    })
})

describe('the testing card', () => {
    const card = () => document.getElementById('caramel-testing-overlay')

    it('is not cancelled by a page script', async () => {
        await showTestingModal()

        pageKey(document, 'Escape')
        pageClicks(card().shadowRoot.querySelector('#caramel-testing-close'))
        await settle()

        expect(globalThis._caramelCancelled).toBe(false)
        expect(card()).not.toBeNull()
        expect(messages.filter(m => m?.op === 'replace')).toEqual([])
    })

    it('is cancelled by the shopper’s ×', async () => {
        await showTestingModal()
        trustedClick(card().shadowRoot.querySelector('#caramel-testing-close'))
        await settle()

        expect(globalThis._caramelCancelled).toBe(true)
        expect(card()).toBeNull()
    })
})

describe('the result card', () => {
    const card = () => document.getElementById('caramel-final-overlay')
    const root = () => card().shadowRoot

    it('is not closed by a page script', async () => {
        await showFinalModal(5, 'SAVE5')

        pageClicks(root().querySelector('#caramel-final-ok-btn'))
        pageClicks(root().querySelector('#caramel-final-close'))
        pageClicks(root().querySelector('.cm-scrim'))
        pageKey(document, 'Escape')
        await settle()

        expect(card()).not.toBeNull()
    })

    it('does not open the extension or copy a code for a page script', async () => {
        // A guest's fallback list: a sign-in nudge that opens the popup, and a
        // copy button on every row.
        const codes = Array.from({ length: 10 }, (_, i) => ({
            code: `CODE${i + 1}`,
            title: `${i + 1}% off`,
        }))
        await showFinalModal(0, null, null, false, codes)
        const login = root().querySelector('#caramel-manual-login')
        const copy = root().querySelector('.caramel-manual-copy')
        expect(login).not.toBeNull()
        expect(copy).not.toBeNull()
        const copyLabel = copy.textContent

        pageClicks(login)
        pageClicks(copy)
        await settle()
        expect(messages.filter(m => m?.action === 'openPopup')).toEqual([])
        expect(copy.textContent).toBe(copyLabel)
        expect(card()).not.toBeNull()

        trustedClick(login)
        await settle()
        expect(messages).toContainEqual({ action: 'openPopup' })
        expect(card()).toBeNull()
    })

    it('does not open the extension from the sign-in card for a page script', async () => {
        await showFinalModal(0, null, null, true)

        pageClicks(root().querySelector('#caramel-final-ok-btn'))
        await settle()
        expect(messages.filter(m => m?.action === 'openPopup')).toEqual([])
    })

    it('closes for the shopper', async () => {
        await showFinalModal(5, 'SAVE5')
        dispatchTrusted(
            root().querySelector('#caramel-final-ok-btn'),
            new MouseEvent('click', { bubbles: true, composed: true }),
        )
        await settle()
        expect(card()).toBeNull()
    })
})
