import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    getOnMessageListeners,
    loadExtensionSource,
    loadExtensionSources,
} from './_load.mjs'

// The popup's "follow this store" star (favorites).
//
// Three things are worth a test here and each has already been a bug class in
// this popup:
//
//  1. THE LOGGED-OUT POPUP MUST BE UNCHANGED. The star is signed-in-only, so a
//     guest's header must render byte-for-byte what it rendered before — no
//     star, no wrapper, no extra control to mis-tap into a sign-in wall.
//  2. THE HEADER MUST NOT GROW. tests/popup-sizing.test.mjs pins .coupon-list's
//     320px cap against a measured ~279px of chrome stacked above it; a star
//     that added a row would slice the last coupon inside body's
//     overflow:hidden. So: one row, two children, star inside the existing row.
//  3. THE ACTION NAME MUST MATCH THE WORKER'S. popup and background.js agree
//     only by string, and background's unknown-action branch answers
//     {error:'unknown_action'} — which the popup would render as a failed
//     toggle rather than anything obviously broken. The round-trip test below
//     drives the REAL background handler with the REAL message the popup
//     produced, so a rename on either side goes red instead of silent (the
//     same producer/consumer discipline as popup-tab-url-contract.test.mjs).

const DOMAIN = 'shop.nike.com'
const USER = { username: 'shopper', image: '' }
const COUPONS = [{ code: 'SAVE10', title: '10% off', status: 'valid' }]

/** Loads the real popup stack (index.html's script order) into a fresh realm
 * and returns renderCouponsView. */
function loadPopup() {
    document.body.innerHTML = '<div id="auth-container"></div>'
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
    return loadExtensionSource('popup.js', ['renderCouponsView'])
}

/** Answers every runtime message from `replies`, recording what was sent.
 * caramelSendMessage rejects on an `undefined` response, so unknown messages
 * get an explicit empty object rather than nothing. */
function stubMessaging(replies) {
    const sent = []
    globalThis.currentBrowser.runtime.sendMessage = (message, cb) => {
        sent.push(message)
        const reply = replies[message?.action]
        cb(typeof reply === 'function' ? reply(message) : (reply ?? {}))
    }
    return sent
}

/** Lets the star's fire-and-forget message round trips settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function starButton() {
    return document.getElementById('favoriteStoreBtn')
}

beforeEach(() => {
    document.body.innerHTML = ''
})

describe('popup header star — signed in', () => {
    it('renders in the header, starts unpressed and disabled, then reflects the account', async () => {
        const { renderCouponsView } = loadPopup()
        stubMessaging({
            getFavoriteStores: { favorites: [{ store: 'nike.com' }] },
        })

        renderCouponsView(COUPONS, USER, DOMAIN)

        // Before the account answers: present, unpressed, and NOT clickable —
        // an enabled star showing a guessed state invites a click that writes
        // the opposite of what the user is looking at.
        const before = starButton()
        expect(before).not.toBeNull()
        expect(before.getAttribute('aria-pressed')).toBe('false')
        expect(before.disabled).toBe(true)

        await settle()

        // "shop.nike.com" is followed because the ACCOUNT is keyed on the
        // registrable domain "nike.com" — the suffix-tolerant match is the
        // whole reason this assertion is interesting.
        const after = starButton()
        expect(after.getAttribute('aria-pressed')).toBe('true')
        expect(after.disabled).toBe(false)
        expect(after.getAttribute('aria-label')).toBe(`Unfollow ${DOMAIN}`)
    })

    it('stays unpressed for a store the account does not follow', async () => {
        const { renderCouponsView } = loadPopup()
        stubMessaging({
            getFavoriteStores: { favorites: [{ store: 'ebay.com' }] },
        })

        renderCouponsView(COUPONS, USER, DOMAIN)
        await settle()

        expect(starButton().getAttribute('aria-pressed')).toBe('false')
        expect(starButton().getAttribute('aria-label')).toBe(`Follow ${DOMAIN}`)
    })

    it('stays disabled — never lying about the state — when the account cannot be reached', async () => {
        const { renderCouponsView } = loadPopup()
        stubMessaging({ getFavoriteStores: { error: 'HTTP 401' } })

        renderCouponsView(COUPONS, USER, DOMAIN)
        await settle()

        expect(starButton().disabled).toBe(true)
        expect(starButton().getAttribute('aria-pressed')).toBe('false')
    })

    it('sits inside the existing header row and adds no row of its own', async () => {
        // The height contract popup-sizing.test.mjs's arithmetic depends on:
        // .coupons-profile-row keeps exactly its two children (info + actions),
        // and the star is a descendant of that row rather than a sibling block.
        const { renderCouponsView } = loadPopup()
        stubMessaging({ getFavoriteStores: { favorites: [] } })

        renderCouponsView(COUPONS, USER, DOMAIN)
        await settle()

        const row = document.querySelector('.coupons-profile-row')
        expect(row.children).toHaveLength(2)
        expect(row.contains(starButton())).toBe(true)
        expect(document.querySelectorAll('.coupons-profile-row')).toHaveLength(
            1,
        )
        // Reuses the header button's sizing rather than introducing a control
        // with its own height.
        expect(starButton().className).toContain('coupons-logout-button')
    })
})

describe('popup header star — logged out', () => {
    it('is absent, and the guest header is exactly what it was before favorites existed', async () => {
        const { renderCouponsView } = loadPopup()
        const sent = stubMessaging({})

        renderCouponsView(COUPONS, null, DOMAIN)
        await settle()

        expect(starButton()).toBeNull()
        expect(document.querySelector('.coupons-header-actions')).toBeNull()
        // The guest header is still the single Log in button, unwrapped.
        const row = document.querySelector('.coupons-profile-row')
        expect(row.children).toHaveLength(2)
        expect(row.lastElementChild.id).toBe('loginToggleBtn')
        // And a signed-out popup must not ask the account anything.
        expect(sent.some(m => m?.action === 'getFavoriteStores')).toBe(false)
        expect(sent.some(m => m?.action === 'setFavoriteStore')).toBe(false)
    })
})

describe('star toggle — round trip through the real service worker', () => {
    /** Replays `message` against the REAL background.js onMessage handler in a
     * fresh realm, with fetch stubbed, and reports what it did. */
    async function replayThroughBackground(message, response) {
        loadExtensionSource('background.js', [])
        const [handler] = getOnMessageListeners()
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => response,
        }))
        globalThis.fetch = fetchMock
        const reply = await new Promise(resolve =>
            handler(message, {}, resolve),
        )
        return { fetchMock, reply }
    }

    it('a click on an unfollowed store sends setFavoriteStore, which the worker turns into a PUT', async () => {
        const { renderCouponsView } = loadPopup()
        const sent = stubMessaging({
            getFavoriteStores: { favorites: [] },
            setFavoriteStore: { ok: true, store: 'nike.com', favorited: true },
        })

        renderCouponsView(COUPONS, USER, DOMAIN)
        await settle()
        starButton().click()
        await settle()

        const toggle = sent.find(m => m?.action === 'setFavoriteStore')
        expect(toggle).toEqual({
            action: 'setFavoriteStore',
            site: DOMAIN,
            favorite: true,
        })
        // The star now shows the server's answer, not the optimistic guess.
        expect(starButton().getAttribute('aria-pressed')).toBe('true')
        expect(starButton().disabled).toBe(false)

        // …and that exact message, unedited, drives the real worker.
        const { fetchMock, reply } = await replayThroughBackground(toggle, {
            ok: true,
            store: 'nike.com',
            favorited: true,
        })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, opts] = fetchMock.mock.calls[0]
        expect(url).toContain(
            `/api/account/favorites/${encodeURIComponent(DOMAIN)}`,
        )
        expect(opts.method).toBe('PUT')
        expect(reply).toEqual({ ok: true, store: 'nike.com', favorited: true })
    })

    it('a click on a followed store sends favorite:false, which the worker turns into a DELETE', async () => {
        const { renderCouponsView } = loadPopup()
        const sent = stubMessaging({
            getFavoriteStores: { favorites: [{ store: 'nike.com' }] },
            setFavoriteStore: { ok: true, store: 'nike.com', favorited: false },
        })

        renderCouponsView(COUPONS, USER, DOMAIN)
        await settle()
        starButton().click()
        await settle()

        const toggle = sent.find(m => m?.action === 'setFavoriteStore')
        expect(toggle.favorite).toBe(false)
        expect(starButton().getAttribute('aria-pressed')).toBe('false')

        const { fetchMock } = await replayThroughBackground(toggle, {
            ok: true,
            store: 'nike.com',
            favorited: false,
        })
        const [, opts] = fetchMock.mock.calls[0]
        expect(opts.method).toBe('DELETE')
    })

    it('a rejected write puts the star back where it was', async () => {
        const { renderCouponsView } = loadPopup()
        stubMessaging({
            getFavoriteStores: { favorites: [] },
            setFavoriteStore: { error: 'HTTP 500' },
        })

        renderCouponsView(COUPONS, USER, DOMAIN)
        await settle()
        starButton().click()
        await settle()

        // Optimistic flip reverted — the popup never claims a follow the
        // account did not record.
        expect(starButton().getAttribute('aria-pressed')).toBe('false')
        expect(starButton().disabled).toBe(false)
    })

    it('the worker answers a store it does not know about with unknown_action (the contract a rename would break)', async () => {
        // Documents the failure mode the round-trip tests above exist to catch:
        // if popup and background stop agreeing on the action string, the
        // worker's fallback replies unknown_action and no request is ever made.
        const { fetchMock, reply } = await replayThroughBackground(
            { action: 'setFavouriteStore', site: DOMAIN, favorite: true },
            {},
        )
        expect(reply).toEqual({ error: 'unknown_action' })
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
