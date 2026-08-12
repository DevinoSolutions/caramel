import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { showFinalModal } from '../UI-helpers.js'

// The result card covers the whole viewport, and for a long time it had exactly
// one way out: the Esc key.
//
// eddiebauer.com (QA sweep 2026-08-05), on a cart holding nothing: the card read
// “Heads up / Your cart is empty” above a single button labelled **Proceed to
// Checkout**, sitting on top of the store's own “Continue shopping” link. On a
// phone — no Esc key — a shopper's only route out of an empty-cart notice was a
// button offering to send them to checkout with an empty cart. Two separate
// failures in one card: no exit, and a promise we had no business making.
//
// Fixed together, because either alone still leaves the shopper stuck with the
// wrong instruction:
//   · a × in the corner, matching the prompt and the testing modal
//   · tapping the dimmed area, which is what everyone tries first
//   · “Proceed to Checkout” only when a code is actually ON the cart
//
// The RTL pin lives here too: `direction` is inherited and inheritance crosses
// into shadow DOM, so mango.com/ae flipped our English copy and ellipsised the
// coupon descriptions at their visual left — cutting off the discount rate,
// which is the only part a shopper scans for.

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const root = () =>
    document.getElementById('caramel-final-overlay')?.shadowRoot ?? null
const modal = () => root()?.querySelector('.caramel-final-modal') ?? null
const scrim = () => root()?.querySelector('.cm-scrim') ?? null
const mounted = () => !!document.getElementById('caramel-final-overlay')

const click = el =>
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))

beforeAll(() => {
    // The bootstrap resolves `currentBrowser` off the chrome global; an
    // identity getURL plus a disk-backed fetch serves the packaged stylesheets
    // (public/assets in the repo, assets/ in the build).
    globalThis.chrome = {
        runtime: { getURL: p => p, lastError: undefined },
        storage: {
            local: { get: (_keys, cb) => cb?.({}), set: (_i, cb) => cb?.() },
            sync: { get: (_keys, cb) => cb?.({}), set: (_i, cb) => cb?.() },
        },
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
})

describe('the shopper can always leave', () => {
    it('offers a × on the card', async () => {
        await showFinalModal(0, null, 'Your cart is empty.')

        expect(root().querySelector('#caramel-final-close')).not.toBeNull()
    })

    it('closes when the × is clicked', async () => {
        await showFinalModal(0, null, 'Your cart is empty.')

        click(root().querySelector('#caramel-final-close'))

        expect(mounted()).toBe(false)
    })

    it('closes when the dimmed area around the card is tapped', async () => {
        await showFinalModal(0, null, 'Your cart is empty.')

        click(scrim())

        expect(mounted()).toBe(false)
    })

    it('stays put when the tap lands on the card itself', async () => {
        // Copying a code or reading the message must not dismiss the result.
        await showFinalModal(0, null, 'Your cart is empty.')

        click(modal())

        expect(mounted()).toBe(true)
    })

    it('stays put when a control inside the card is used', async () => {
        await showFinalModal(0, null, null, false, [
            { code: 'SAVE10', title: '10% off' },
        ])

        click(root().querySelector('.caramel-manual-copy'))

        expect(mounted()).toBe(true)
    })

    it('still closes on Esc', async () => {
        await showFinalModal(0, null, 'Your cart is empty.')

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

        expect(mounted()).toBe(false)
    })
})

describe('the button only promises what happened', () => {
    const label = () =>
        root().querySelector('#caramel-final-ok-btn').textContent

    it('does not send an empty-cart shopper to checkout', async () => {
        // The eddiebauer card, exactly.
        await showFinalModal(0, null, 'Your cart is empty.')

        expect(label()).toBe('Got it')
    })

    it('offers checkout when a saving really landed', async () => {
        await showFinalModal(12.5, 'SAVE10')

        expect(label()).toBe('Proceed to Checkout')
    })

    it('offers checkout when a code applied but the saving was unmeasurable', async () => {
        await showFinalModal(0, 'SAVE10')

        expect(label()).toBe('Proceed to Checkout')
    })

    it('drops the primary button entirely on a list-of-codes card (lighter UI)', async () => {
        // The card carries its own controls (copy buttons, the report link) and
        // three ways out (×, scrim, Esc) — a generic "Done" under all that is
        // just clutter.
        await showFinalModal(0, null, null, false, [{ code: 'SAVE10' }])

        expect(root().querySelector('#caramel-final-ok-btn')).toBeNull()
    })

    it('says Sign In when that is the ask', async () => {
        await showFinalModal(0, null, null, true)

        expect(label()).toBe('Sign In')
    })
})

describe('our surfaces read left-to-right on a right-to-left store', () => {
    // `direction` inherits, and inheritance crosses the shadow boundary — so
    // this has to be pinned on the HOST, before any of our own rules run.
    it('pins the reading direction on the overlay host', async () => {
        await showFinalModal(0, null, 'Your cart is empty.')

        expect(
            document.getElementById('caramel-final-overlay').style.direction,
        ).toBe('ltr')
    })

    it('pins it on the prompt host too', () => {
        // Read from the shared table rather than mounting the prompt, which
        // needs the settings gate; the prompt is where the clipped descriptions
        // were actually seen.
        const css = readFileSync(join(EXT_ROOT, 'UI-helpers.js'), 'utf8')
        const table = css.slice(css.indexOf('const CARAMEL_HOST_CSS'))
        expect(table.slice(0, table.indexOf('}'))).toMatch(/direction:ltr/)
    })
})
