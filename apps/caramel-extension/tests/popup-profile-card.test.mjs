import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    backStorageArea,
    loadExtensionSource,
    loadExtensionSources,
} from './_load.mjs'

// WXT-migration P0 characterization pins (2026-08-12)
//
// renderProfileCard (popup.js:1085-1115) had ZERO coverage. It is the view a
// SIGNED-IN user gets whenever the popup cannot read a web tab URL — opened on
// a new tab, on a chrome:// page, or as its own window — so it is the only
// place some users ever see their account in the extension, and the only
// signed-in surface with no coupon list to prove it rendered at all.
//
// Three things are frozen: what it paints (username + avatar, with the bundled
// default when the account has no image), that the `token && !url` branch in
// initPopup (popup.js:358) really routes here, and that its Log out button is
// wired to the shared revoke path. The logout MECHANICS (revoke before clear,
// offline still signs out) are already pinned in popup-logout-revoke.test.mjs
// — this suite only proves this view's button reaches them, so the rewrite
// cannot ship a profile card whose logout quietly does nothing.
let renderProfileCard
let initPopup
let tabUrlAnswer

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

    globalThis.currentBrowser.runtime.sendMessage = (message, cb) => {
        if (message?.action === 'getActiveTabDomainRecord') {
            cb(tabUrlAnswer)
        } else {
            cb(undefined)
        }
    }
    ;({ renderProfileCard, initPopup } = loadExtensionSource('popup.js', [
        'renderProfileCard',
        'initPopup',
    ]))
})

beforeEach(() => {
    document.getElementById('auth-container').innerHTML = ''
    // A chrome:// tab is a real signed-in-user-with-no-store situation and the
    // exact input popup.js:310 nulls out, which is what sends initPopup down
    // the profile-card branch.
    tabUrlAnswer = { url: 'chrome://newtab/' }
    // ALWAYS two separate objects: the session lives in local, and a shared
    // object would let caramelGetSession's pre-migration sync adoption path
    // see a token it should never find.
    backStorageArea('local', {
        token: 'stored-token',
        user: { username: 'shopper', image: '' },
    })
    backStorageArea('sync', {})
    // The /api/extension/me probe initPopup fires in parallel. A 5xx is the
    // one answer validateStoredSession treats as "backend hiccup, change
    // nothing" — so it cannot rewrite the stored user mid-assertion.
    globalThis.fetch = async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
    })
})

const cardHtml = () => document.getElementById('auth-container').innerHTML

describe('popup profile card — what a signed-in user with no store tab sees', () => {
    it('paints the account username and its avatar', () => {
        renderProfileCard({
            username: 'shopper',
            image: 'https://cdn.example.com/avatar.png',
        })

        expect(cardHtml()).toContain('@shopper')
        const avatar = document.querySelector('.coupons-profile-image')
        expect(avatar.getAttribute('src')).toBe(
            'https://cdn.example.com/avatar.png',
        )
    })

    it('falls back to the bundled default avatar when the account has no image', () => {
        // Both shapes an account with no picture arrives in: absent, and the
        // empty string the login response actually sends. `image?.length` is
        // what decides, so '' must fall back rather than render src="".
        for (const user of [
            { username: 'shopper', image: null },
            { username: 'shopper', image: '' },
            { username: 'shopper' },
        ]) {
            renderProfileCard(user)
            expect(
                document
                    .querySelector('.coupons-profile-image')
                    .getAttribute('src'),
                JSON.stringify(user),
            ).toBe('assets/default-profile.png')
        }
    })

    it('is the view initPopup routes to when there is a session but no readable tab URL', async () => {
        const seen = []
        const real = globalThis.renderProfileCard
        globalThis.renderProfileCard = user => {
            seen.push(user)
            return real(user)
        }
        try {
            await initPopup()
        } finally {
            globalThis.renderProfileCard = real
        }

        expect(seen).toHaveLength(1)
        expect(seen[0]).toEqual({ username: 'shopper', image: '' })
        expect(cardHtml()).toContain('@shopper')
    })

    it('shows the settings gear, which is hidden until a view asks for it', () => {
        document.getElementById('settingsIcon').style.display = 'none'

        renderProfileCard({ username: 'shopper', image: '' })

        const gear = document.getElementById('settingsIcon')
        expect(gear.style.display).toBe('block')
        expect(typeof gear.onclick).toBe('function')
    })

    it('wires Log out to the shared revoke path rather than clearing storage itself', () => {
        renderProfileCard({ username: 'shopper', image: '' })

        const logoutBtn = document.getElementById('logoutBtn')
        expect(
            logoutBtn,
            'the profile card renders a logout button',
        ).toBeTruthy()

        const real = globalThis.signOutAndRevoke
        const spy = vi.fn()
        globalThis.signOutAndRevoke = spy
        try {
            logoutBtn.click()
        } finally {
            globalThis.signOutAndRevoke = real
        }

        expect(spy).toHaveBeenCalledTimes(1)
        // Second argument is the pressed control — signOutAndRevoke disables
        // it while the revoke is in flight, so passing it is load-bearing.
        expect(spy.mock.calls[0][1]).toBe(logoutBtn)
    })
})
