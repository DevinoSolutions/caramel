import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadExtensionSources } from './_load.mjs'

// One screen was answering three different questions with the same sentence.
//
// "No coupons for this site yet" is a verdict ABOUT A STORE — but this view is
// also where the popup lands when there is no store at all: a new tab, a PDF, a
// settings page, anywhere the extension cannot read a URL. Clicking the toolbar
// icon before going shopping is the most likely first thing a new user ever
// does with Caramel, and it answered with a judgement on a shop they were not
// in, plus a link to "the stores we support" that reads as an apology.
//
// It is also the only place the popup can say what the product IS. QA's
// first-time users had to work that out from a pill that shows up on a checkout;
// nothing in the extension ever introduces itself. The moment someone opens it
// with no store in front of them is precisely when that sentence helps.
//
// The third case — "we cover this store, nothing is working right now" — is
// pinned in tests/supported-but-no-codes.test.mjs.

let renderUnsupportedSite

const heading = () => document.getElementById('noCouponsHeading').textContent
const body = () => document.getElementById('noCouponsBody').textContent

beforeAll(() => {
    ;({ renderUnsupportedSite } = loadExtensionSources(
        ['caramel-base.js', 'popup.js'],
        ['renderUnsupportedSite'],
    ))
})

beforeEach(() => {
    document.body.innerHTML = '<div id="auth-container"></div>'
    // The view wires a settings gear and may consult the supported-store list;
    // neither is what these pin.
    globalThis.wireSettingsGear = () => {}
    globalThis.caramelUrl = path => `https://grabcaramel.com/${path}`
    const target = globalThis.currentBrowser ?? globalThis.chrome
    target.runtime.lastError = null
    target.runtime.sendMessage = vi.fn((_msg, cb) => cb({ supported: [] }))
})

describe('opened with no store in front of the user', () => {
    it('does not deliver a verdict about a store', async () => {
        renderUnsupportedSite(null)

        expect(heading()).not.toMatch(/no coupons for this site/i)
    })

    it('says what Caramel actually does', async () => {
        renderUnsupportedSite(null)

        expect(body()).toMatch(/coupon codes/i)
        expect(body()).toMatch(/checkout/i)
    })

    it('tells the user what to do next', async () => {
        renderUnsupportedSite(null)

        expect(body()).toMatch(/cart/i)
    })

    it('still offers the list of stores, which is a real answer here', async () => {
        renderUnsupportedSite(null)

        expect(document.getElementById('supportedStoresLink')).not.toBeNull()
    })

    it('still offers the sign-in door', async () => {
        renderUnsupportedSite(null)

        expect(document.getElementById('loginToggleBtn')).not.toBeNull()
    })

    it('offers log out instead when someone is signed in', async () => {
        renderUnsupportedSite({ email: 'a@b.com' })

        expect(document.getElementById('logoutBtn')).not.toBeNull()
    })
})

describe('opened on a store we do not cover', () => {
    it('still says so, in the store’s own terms', async () => {
        renderUnsupportedSite(null, 'en.wikipedia.org')

        expect(heading()).toMatch(/no coupons for this site/i)
        expect(body()).toMatch(/stores we support|ones we support/i)
    })
})
