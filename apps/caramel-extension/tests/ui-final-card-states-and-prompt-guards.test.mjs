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
    insertCaramelPrompt,
    showFinalModal,
    showTestingModal,
} from '../UI-helpers.js'
import { trustedClick, trustedKey } from './_trusted-events.mjs'

// Characterization suite (T-5446), written BEFORE UI-helpers.js is split into
// modules. It pins what the result card and the prompt do that no other suite
// asserts: the heading, message and button of every card state; that a
// success card never offers a copy list; the member cap of 20 and the guest
// gate's wording at the edge; the copy button's two labels; that the card
// takes the testing overlay down and hands focus back; the sign-in button
// opening the popup; markup in a code or title staying inert; and the
// prompt's gates (settings, paused site, one at a time), what a click versus
// a × records, and that a failed run never leaves the overlay behind.

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const stubs = vi.hoisted(() => ({ start: null }))

vi.mock('../coupon-runner.js', async importOriginal => ({
    ...(await importOriginal()),
    startApplyingCoupons: (...args) => stubs.start(...args),
}))

let syncData
let localData
let sent

const area = data => ({
    get: (_keys, cb) => cb?.({ ...data }),
    set: (items, cb) => {
        Object.assign(data, items)
        cb?.()
    },
    remove: (keys, cb) => {
        for (const key of [].concat(keys)) delete data[key]
        cb?.()
    },
})

const card = () => document.getElementById('caramel-final-overlay')?.shadowRoot
const text = sel => card()?.querySelector(sel)?.textContent
const rows = () => [...(card()?.querySelectorAll('.caramel-manual-row') ?? [])]
const prompt = () => document.getElementById('caramel-small-prompt')
const codes = n =>
    Array.from({ length: n }, (_, i) => ({
        code: `CODE${i + 1}`,
        title: `${i + 1}% off`,
    }))

beforeAll(() => {
    syncData = {}
    localData = {}
    sent = []
    globalThis.chrome = {
        runtime: {
            getURL: p => p,
            lastError: undefined,
            sendMessage: msg => sent.push(msg),
        },
        storage: { local: area(localData), sync: area(syncData) },
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
    for (const data of [syncData, localData])
        for (const key of Object.keys(data)) delete data[key]
    sent.length = 0
    sessionStorage.clear()
    stubs.start = async () => {}
})

afterEach(() => {
    vi.useRealTimers()
    delete navigator.clipboard
    delete document.execCommand
})

describe('the result card — one card per state', () => {
    it.each([
        {
            name: 'a measured saving',
            args: [7.5, 'SAVE10'],
            heading: 'Savings Found',
            message: 'We found a code that works and applied it for you.',
            button: 'Proceed to Checkout',
        },
        {
            name: 'a saving, whatever message the caller passed',
            args: [7.5, 'SAVE10', 'caller words that must not show'],
            heading: 'Savings Found',
            message: 'We found a code that works and applied it for you.',
            button: 'Proceed to Checkout',
        },
        {
            name: 'a code applied but unmeasurable',
            args: [0, 'SAVE10'],
            heading: '✓ Coupon Applied',
            message:
                'Code SAVE10 is applied to your cart — review the discount before you check out.',
            button: 'Proceed to Checkout',
        },
        {
            name: "a code applied, with the caller's own message",
            args: [0, 'SAVE10', 'Your total did not change.'],
            heading: '✓ Coupon Applied',
            message: 'Your total did not change.',
            button: 'Proceed to Checkout',
        },
        {
            name: 'a list of codes to paste',
            args: [0, null, null, false, codes(2)],
            heading: 'Grab a code',
            message:
                "Auto-apply didn't stick this time. Copy a code and paste it in the store's promo box.",
            button: undefined,
        },
        {
            name: "a list of codes, with the store's own reason",
            args: [0, null, 'The store said: “expired”', false, codes(2)],
            heading: 'Grab a code',
            message: 'The store said: “expired”',
            button: undefined,
        },
        {
            name: 'a sign-in ask',
            args: [0, null, null, true],
            heading: 'Sign in to continue',
            message: 'Sign in to unlock member-only coupons for this store.',
            button: 'Sign In',
        },
        {
            name: 'nothing to offer',
            args: [0, null],
            heading: 'Heads up',
            message: "Looks like you're already getting the best deal.",
            button: 'Got it',
        },
        {
            name: 'nothing to offer, with a caller message',
            args: [0, null, 'Your cart is empty — add something.'],
            heading: 'Heads up',
            message: 'Your cart is empty — add something.',
            button: 'Got it',
        },
    ])('shows $name', async ({ args, heading, message, button }) => {
        await showFinalModal(...args)

        expect(text('h2')).toBe(heading)
        expect(text('.caramel-final-msg')).toBe(message)
        expect(text('#caramel-final-ok-btn')).toBe(button)
    })

    it('puts the amount and the code in the win panel of a measured saving', async () => {
        await showFinalModal(7.5, 'SAVE10')

        expect(text('.caramel-final-eyebrow')).toBe('You saved')
        expect(text('.caramel-final-savings')).toBe('$7.50')
        expect(text('.caramel-final-code span')).toBe('SAVE10')
        expect(card().querySelector('.caramel-final-hint')).toBeNull()
    })

    it('says only that the discount is visible when no amount could be measured', async () => {
        await showFinalModal(0, 'SAVE10')

        expect(card().querySelector('.caramel-final-savings')).toBeNull()
        expect(text('.caramel-final-code span')).toBe('SAVE10')
        expect(text('.caramel-final-hint')).toBe(
            'Discount visible in your cart.',
        )
    })

    it('never offers a copy list on a success card, even when handed one', async () => {
        await showFinalModal(7.5, 'SAVE10', null, false, codes(3))

        expect(rows()).toEqual([])
        expect(card().querySelector('.caramel-manual-list')).toBeNull()
        expect(card().querySelector('#caramel-manual-feedback')).toBeNull()
    })

    it('ignores list entries that are not codes', async () => {
        await showFinalModal(0, null, null, false, [
            null,
            {},
            { title: 'no code' },
            { code: '' },
            { code: 'REAL' },
        ])

        expect(
            rows().map(
                r => r.querySelector('.caramel-manual-code').textContent,
            ),
        ).toEqual(['REAL'])
    })
})

describe('the result card — the copy list', () => {
    it('gives a signed-in shopper at most 20 codes', async () => {
        localData.token = 'tok'
        localData.user = { username: 'shopper' }

        await showFinalModal(0, null, null, false, codes(25))

        expect(rows()).toHaveLength(20)
        expect(card().querySelector('.caramel-manual-gate')).toBeNull()
    })

    it('gates a guest one code over the cap, naming the real total', async () => {
        await showFinalModal(0, null, null, false, codes(7))

        expect(rows()).toHaveLength(6)
        expect(text('#caramel-manual-login')).toBe('Sign in for all 7 codes')
    })

    it('puts the code it copies in data-code, exactly as shown', async () => {
        await showFinalModal(0, null, null, false, [
            { code: 'A B-1', title: '' },
        ])

        expect(
            card()
                .querySelector('.caramel-manual-copy')
                .getAttribute('data-code'),
        ).toBe('A B-1')
    })

    it('keeps markup in a code or a title inert', async () => {
        await showFinalModal(0, null, null, false, [
            {
                code: '<img src=x onerror=alert(1)>',
                title: '<b>20%</b> off "now"',
            },
        ])

        const root = card()
        expect(root.querySelector('.caramel-manual-list img')).toBeNull()
        expect(root.querySelector('.caramel-manual-title b')).toBeNull()
        expect(root.querySelector('.caramel-manual-code').textContent).toBe(
            '<img src=x onerror=alert(1)>',
        )
        expect(root.querySelector('.caramel-manual-title').textContent).toBe(
            '<b>20%</b> off "now"',
        )
        expect(
            root
                .querySelector('.caramel-manual-copy')
                .getAttribute('data-code'),
        ).toBe('<img src=x onerror=alert(1)>')
    })

    it('keeps markup in the code of a win inert too', async () => {
        await showFinalModal(5, '<script>x</script>')

        expect(card().querySelector('.caramel-final-code script')).toBeNull()
        expect(text('.caramel-final-code span')).toBe('<script>x</script>')
    })

    describe('the copy button', () => {
        it('says Copied! and turns green, then goes back after 1.6s', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout'] })
            Object.defineProperty(navigator, 'clipboard', {
                value: { writeText: async () => {} },
                configurable: true,
            })
            await showFinalModal(0, null, null, false, codes(1))
            const btn = card().querySelector('.caramel-manual-copy')

            trustedClick(btn)
            await vi.advanceTimersByTimeAsync(0)

            expect(btn.textContent).toBe('Copied!')
            expect(btn.classList.contains('is-copied')).toBe(true)

            await vi.advanceTimersByTimeAsync(1600)

            expect(btn.textContent).toBe('Copy')
            expect(btn.classList.contains('is-copied')).toBe(false)
        })

        it('asks for Ctrl+C when neither copy route works, and does not turn green', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout'] })
            await showFinalModal(0, null, null, false, codes(1))
            const btn = card().querySelector('.caramel-manual-copy')

            trustedClick(btn)
            await vi.advanceTimersByTimeAsync(0)

            expect(btn.textContent).toBe('Press Ctrl+C')
            expect(btn.classList.contains('is-copied')).toBe(false)

            await vi.advanceTimersByTimeAsync(1600)

            expect(btn.textContent).toBe('Copy')
        })
    })
})

describe('the result card — around it', () => {
    it('takes the testing overlay down when it appears', async () => {
        await showTestingModal()
        expect(
            document.getElementById('caramel-testing-overlay'),
        ).not.toBeNull()

        await showFinalModal(0, null)

        expect(document.getElementById('caramel-testing-overlay')).toBeNull()
        expect(document.getElementById('caramel-final-overlay')).not.toBeNull()
    })

    it('hands focus back to the page when it closes', async () => {
        document.body.innerHTML = '<button id="page-button">Checkout</button>'
        const pageButton = document.getElementById('page-button')
        pageButton.focus()
        await showFinalModal(0, null)

        trustedClick(card().querySelector('#caramel-final-ok-btn'))

        expect(document.getElementById('caramel-final-overlay')).toBeNull()
        expect(document.activeElement).toBe(pageButton)
    })

    it('stops listening for Esc once it is closed', async () => {
        document.body.innerHTML =
            '<button id="opener">Checkout</button><button id="elsewhere">Shipping</button>'
        document.getElementById('opener').focus()
        await showFinalModal(0, null)
        trustedClick(card().querySelector('#caramel-final-ok-btn'))
        const elsewhere = document.getElementById('elsewhere')
        elsewhere.focus()

        trustedKey(document, 'Escape')

        // A card still listening would close again and hand focus back to the
        // opener, pulling it off what the shopper is doing.
        expect(document.activeElement).toBe(elsewhere)
    })

    it('opens the popup from its Sign In button, and closes', async () => {
        await showFinalModal(0, null, null, true)

        trustedClick(card().querySelector('#caramel-final-ok-btn'))

        expect(sent).toEqual([{ action: 'openPopup' }])
        expect(document.getElementById('caramel-final-overlay')).toBeNull()
    })

    it('does not open the popup from the Proceed to Checkout button', async () => {
        await showFinalModal(5, 'SAVE10')

        trustedClick(card().querySelector('#caramel-final-ok-btn'))

        expect(sent).toEqual([])
        expect(document.getElementById('caramel-final-overlay')).toBeNull()
    })

    it('is a modal dialog named "Caramel coupons" that takes focus itself', async () => {
        await showFinalModal(0, null)

        const modal = card().querySelector('.caramel-final-modal')
        expect(modal.getAttribute('role')).toBe('dialog')
        expect(modal.getAttribute('aria-modal')).toBe('true')
        expect(modal.getAttribute('aria-label')).toBe('Caramel coupons')
        expect(card().activeElement).toBe(modal)
    })
})

describe('the prompt — when it appears', () => {
    it('does not appear when auto-apply is switched off', async () => {
        syncData.caramel_settings = { autoApply: false }

        await insertCaramelPrompt({ domain: 'example.com' })

        expect(prompt()).toBeNull()
    })

    it('does not appear on a site the shopper paused', async () => {
        syncData.caramel_settings = { disabledSites: [location.hostname] }

        await insertCaramelPrompt({ domain: 'example.com' })

        expect(prompt()).toBeNull()
    })

    it('appears when settings were never written', async () => {
        await insertCaramelPrompt({ domain: 'example.com' })

        expect(prompt()).not.toBeNull()
    })

    it('puts up one prompt when two inserts race', async () => {
        await Promise.all([
            insertCaramelPrompt({ domain: 'example.com' }),
            insertCaramelPrompt({ domain: 'example.com' }),
        ])

        expect(document.querySelectorAll('#caramel-small-prompt')).toHaveLength(
            1,
        )
    })

    it('is a button named for what it does', async () => {
        await insertCaramelPrompt({ domain: 'example.com' })

        expect(prompt().getAttribute('aria-label')).toBe(
            'Try Caramel Coupons — auto-apply the best code at checkout',
        )
        const root = prompt().shadowRoot
        expect(root.querySelector('.caramel-prompt-label').textContent).toBe(
            'Try Caramel Coupons',
        )
        expect(root.querySelector('small').textContent).toBe(
            'Auto-apply the best code at checkout',
        )
        expect(
            root.querySelector('.caramel-prompt-logo').getAttribute('src'),
        ).toBe('assets/logo-light.png')
        expect(
            root.querySelector('#caramel-close-btn').getAttribute('aria-label'),
        ).toBe('Dismiss')
    })
})

describe('the prompt — what a click records', () => {
    it('starts the run for this store, takes the prompt down, and does not remember a "no"', async () => {
        const started = []
        stubs.start = async rec => {
            started.push(rec)
        }
        const rec = { domain: 'example.com' }
        await insertCaramelPrompt(rec)

        trustedClick(prompt())

        expect(started).toEqual([rec])
        expect(prompt()).toBeNull()
        // Going INTO the flow is not a refusal: the tab is not silenced.
        expect(sessionStorage.getItem('caramel_prompt_dismissed')).toBeNull()
    })

    it('starts the run on Space as well as Enter', async () => {
        const started = []
        stubs.start = async rec => {
            started.push(rec)
        }
        await insertCaramelPrompt({ domain: 'example.com' })

        trustedKey(prompt(), ' ')

        expect(started).toHaveLength(1)
        expect(prompt()).toBeNull()
    })

    it('starts nothing on any other key', async () => {
        const started = []
        stubs.start = async rec => {
            started.push(rec)
        }
        await insertCaramelPrompt({ domain: 'example.com' })

        trustedKey(prompt(), 'a')
        trustedKey(prompt(), 'Tab')

        expect(started).toEqual([])
        expect(prompt()).not.toBeNull()
    })

    it('remembers a "no" when the shopper presses the ×, for this tab only', async () => {
        const started = []
        stubs.start = async rec => {
            started.push(rec)
        }
        await insertCaramelPrompt({ domain: 'example.com' })

        trustedClick(prompt().shadowRoot.querySelector('#caramel-close-btn'))

        expect(started).toEqual([])
        expect(prompt()).toBeNull()
        expect(sessionStorage.getItem('caramel_prompt_dismissed')).toBe('1')
        await insertCaramelPrompt({ domain: 'example.com' })
        expect(prompt()).toBeNull()
    })

    it('takes the overlay down when the run it started fails', async () => {
        stubs.start = async () => {
            throw new Error('apply flow blew up')
        }
        await insertCaramelPrompt({ domain: 'example.com' })
        await showTestingModal()
        expect(
            document.getElementById('caramel-testing-overlay'),
        ).not.toBeNull()

        trustedClick(prompt())
        await new Promise(r => setTimeout(r, 0))

        expect(document.getElementById('caramel-testing-overlay')).toBeNull()
    })
})
