import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    EXT_ROOT,
    backStorageArea,
    loadExtensionSource,
    loadExtensionSources,
} from './_load.mjs'

// The manual "Grab a code" fallback must not hand a signed-out shopper more
// codes than the popup does. The popup caps a guest at GUEST_COUPON_LIMIT (6)
// with a sign-in nudge (popup.js couponGuestGateHtml); before this the fallback
// showed up to CARAMEL_MANUAL_LIST_MAX (20) to EVERYONE — a guest could copy
// more codes here than the popup would ever show them, leaking the gated value
// and skipping the growth nudge. Members still get the full list. This pins the
// consistency so the two surfaces can't drift apart again.

let showFinalModal

const root = () =>
    document.getElementById('caramel-final-overlay')?.shadowRoot ?? null
const rows = () => root()?.querySelectorAll('.caramel-manual-row') ?? []
const gate = () => root()?.querySelector('.caramel-manual-gate') ?? null
const loginBtn = () => root()?.querySelector('#caramel-manual-login') ?? null
const feedbackLink = () =>
    root()?.querySelector('#caramel-manual-feedback') ?? null
const mounted = () => !!document.getElementById('caramel-final-overlay')

const click = el =>
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))

// N distinct code rows — every one un-rejected, so ordering is stable.
const codes = n =>
    Array.from({ length: n }, (_, i) => ({
        code: `CODE${i + 1}`,
        title: `${i + 1}% off`,
    }))

const asGuest = () => {
    backStorageArea('local', {})
    backStorageArea('sync', {})
}
const asMember = () => {
    backStorageArea('local', { token: 'tok', user: { username: 'shopper' } })
    backStorageArea('sync', {})
}

beforeAll(() => {
    loadExtensionSource('coupon-constants.generated.js', [])
    ;({ showFinalModal } = loadExtensionSources(
        [
            'caramel-base.js',
            'dom-utils.js',
            'store-detect.js',
            'coupon-apply.js',
            'coupon-fetch.js',
            'coupon-runner.js',
            'UI-helpers.js',
        ],
        ['showFinalModal'],
    ))
    globalThis.currentBrowser.runtime.getURL = p => p
    globalThis.fetch = async relPath => ({
        ok: true,
        text: async () => readFileSync(join(EXT_ROOT, relPath), 'utf8'),
    })
})

beforeEach(() => {
    document.body.innerHTML = ''
})

describe('the fallback code list matches the popup guest cap', () => {
    it('caps a signed-out shopper at the guest limit (6) when there are more', async () => {
        asGuest()
        await showFinalModal(0, null, null, false, codes(10))

        expect(rows().length).toBe(6)
    })

    it('offers the one action that reveals the rest — the count lives in the button', async () => {
        asGuest()
        await showFinalModal(0, null, null, false, codes(10))

        expect(gate()).not.toBeNull()
        expect(loginBtn()).not.toBeNull()
        expect(loginBtn().textContent).toMatch(/Sign in for all 10 codes/)
    })

    it('shows a signed-in shopper the full list, with no gate', async () => {
        asMember()
        await showFinalModal(0, null, null, false, codes(10))

        expect(rows().length).toBe(10)
        expect(gate()).toBeNull()
    })

    it('does not gate a guest when the store has at or under the cap', async () => {
        // The gate only exists when it hides something — a short list looks
        // identical to guest and member (popup rule).
        asGuest()
        await showFinalModal(0, null, null, false, codes(4))

        expect(rows().length).toBe(4)
        expect(gate()).toBeNull()
    })

    it('the sign-in nudge opens the popup and closes the card', async () => {
        asGuest()
        const sent = []
        globalThis.currentBrowser.runtime.sendMessage = msg => sent.push(msg)
        await showFinalModal(0, null, null, false, codes(10))

        click(loginBtn())

        expect(mounted()).toBe(false)
        expect(sent).toContainEqual({ action: 'openPopup' })
    })
})

describe('the fallback offers a graceful way to report a problem', () => {
    it('links to the prod support/feedback form whenever codes are offered', async () => {
        asGuest()
        await showFinalModal(0, null, null, false, codes(3))

        const link = feedbackLink()
        expect(link).not.toBeNull()
        expect(link.getAttribute('href')).toMatch(
            /^https:\/\/grabcaramel\.com\/support$/,
        )
        expect(link.getAttribute('target')).toBe('_blank')
        expect(link.getAttribute('rel')).toMatch(/noopener/)
    })

    it('does not show the report link on a success card', async () => {
        asMember()
        await showFinalModal(12.5, 'SAVE10')

        expect(feedbackLink()).toBeNull()
    })
})
