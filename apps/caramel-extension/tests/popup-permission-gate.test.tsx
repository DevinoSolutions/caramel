import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { App } from '../entrypoints/popup/App'
import { allSitesOriginPattern } from '../permission-state.js'

/**
 * The missing-host-permission gate (2026-08-18/19).
 *
 * Measured in real Firefox: with the `https://*` + `/*` grant absent, the
 * background fetch to the API fails (the server sends no CORS headers to an
 * origin it was never asked to trust) and the popup painted LoadErrorView —
 * "Couldn't load coupons — check your connection and try again". The
 * connection was fine; the browser had refused the request. Two cohorts land
 * there: Firefox auto-updates from <=1.0.3, which silently kept only four old
 * narrow host grants, and fresh installs with the box left unchecked.
 *
 * What these pins own is the DISCRIMINATION, in both directions. A permission
 * prompt shown to someone who is merely offline is a dead end with no retry,
 * which is why "the offline case keeps the connection copy" is pinned as hard
 * as the new view is. The half-working install (API reachable on a narrow
 * grant, content script dead on every store) has no symptom of its own, so the
 * banner is pinned too.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Permissive chrome stub — the same Proxy harness popup-loader.test.tsx uses.
 *  NOTE the trap it carries for this suite: anything not explicitly set is
 *  auto-created as a callable returning undefined, so an unset
 *  `permissions.contains` LOOKS like a working API and then never calls its
 *  callback. Every test below therefore arms permissions explicitly — an
 *  omission would silently exercise a branch nobody meant to test. */
function installChromeStub() {
    const cache = new WeakMap()
    const wrap = (target: any): any => {
        if (cache.has(target)) return cache.get(target)
        const proxy = new Proxy(target, {
            get(obj: any, prop) {
                if (prop === 'then' || typeof prop === 'symbol')
                    return undefined
                if (!(prop in obj)) obj[prop] = wrap(function () {})
                return obj[prop]
            },
            apply: () => undefined,
        })
        cache.set(target, proxy)
        return proxy
    }
    const stub = wrap(function chromeStubRoot() {})
    for (const area of ['sync', 'local', 'session']) {
        stub.storage[area].get = (_keys: unknown, cb: any) => {
            if (typeof cb === 'function') cb({})
        }
        stub.storage[area].set = (_items: unknown, cb: any) => {
            if (typeof cb === 'function') cb()
        }
        stub.storage[area].remove = (_keys: unknown, cb: any) => {
            if (typeof cb === 'function') cb()
        }
    }
    stub.runtime.lastError = undefined
    ;(globalThis as any).chrome = stub
    ;(globalThis as any).browser = undefined
    ;(window as any).chrome = stub
    ;(window as any).browser = undefined
    initCaramelBase()
    return stub
}

let chromeStub: any

/** Coupon transport: `null` answer = the fetch throws (the LoadError path). */
function armTransport(answer: unknown) {
    chromeStub.runtime.sendMessage = (message: any, cb: any) => {
        if (message?.action === 'getActiveTabDomainRecord') {
            cb({ url: 'https://example.com/cart' })
        } else if (message?.action === 'fetchCoupons') {
            cb(answer)
        } else {
            cb(undefined)
        }
    }
}

/** Arms permissions.contains/request. `granted` is what contains() answers;
 *  `requestAnswer` is what the prompt resolves to. Returns the recorded calls. */
function armPermissions(granted: boolean, requestAnswer = false) {
    const containsCalls: unknown[] = []
    const requestCalls: unknown[] = []
    chromeStub.permissions.contains = (perms: unknown, cb: any) => {
        containsCalls.push(perms)
        cb(granted)
    }
    chromeStub.permissions.request = (perms: unknown, cb: any) => {
        requestCalls.push(perms)
        cb(requestAnswer)
    }
    return { containsCalls, requestCalls }
}

/** The popup-context probe permission-state.js runs when the fetch failed. */
function armProbe(outcome: 'ok' | 'blocked' | 'err') {
    const fetchMock = vi.fn(() => {
        if (outcome === 'ok') return Promise.resolve(new Response('{}'))
        // A missing host permission makes fetch reject with a TypeError; the
        // MESSAGE differs per engine ("NetworkError when attempting to fetch
        // resource" vs "Failed to fetch"), which is exactly why the type is
        // what the module reads.
        return Promise.reject(
            outcome === 'blocked'
                ? new TypeError(
                      'NetworkError when attempting to fetch resource',
                  )
                : new Error('boom'),
        )
    })
    ;(globalThis as any).fetch = fetchMock
    return fetchMock
}

const permissionHeading = () =>
    screen.queryByText('Enable Caramel to get started')
const connectionHeading = () => screen.queryByText("Couldn't load coupons")
const banner = () => screen.queryByText("Caramel can't run on every store yet.")

beforeAll(() => {
    initCouponConstants()
    chromeStub = installChromeStub()
})

beforeEach(() => {
    // getURL decides isSafariExtensionRuntime(); reset it so one Safari test
    // cannot leak its runtime into the rest of the file.
    chromeStub.runtime.getURL = () => 'chrome-extension://caramel/'
    delete (globalThis as any).fetch
})

describe('a coupon fetch the BROWSER refused is not a connection problem', () => {
    it('shows the permission view when the fetch fails, the probe is refused with a TypeError, and the grant is absent', async () => {
        armTransport({ error: 'HTTP 500' })
        armPermissions(false)
        armProbe('blocked')

        render(<App />)

        await waitFor(() => expect(permissionHeading()).toBeInTheDocument())
        // The measured symptom this replaces: connection copy over a working
        // connection. It must be GONE, not merely joined.
        expect(connectionHeading()).not.toBeInTheDocument()
        expect(
            screen.getByRole('button', { name: 'Enable Caramel' }),
        ).toBeInTheDocument()
    })

    it('keeps the connection copy when the fetch fails for a reason that is NOT a refusal (offline, backend down)', async () => {
        armTransport({ error: 'HTTP 500' })
        armPermissions(false)
        armProbe('err')

        render(<App />)

        await waitFor(() => expect(connectionHeading()).toBeInTheDocument())
        // Sending someone who is offline to a permission prompt is a dead end:
        // the grant is already theirs to give and giving it changes nothing.
        expect(permissionHeading()).not.toBeInTheDocument()
    })

    it('keeps the connection copy when the probe itself succeeds — the request left the machine, so permissions are not the fault', async () => {
        armTransport({ error: 'HTTP 500' })
        armPermissions(true)
        armProbe('ok')

        render(<App />)

        await waitFor(() => expect(connectionHeading()).toBeInTheDocument())
        expect(permissionHeading()).not.toBeInTheDocument()
    })

    it('hides the settings gear on the permission view, exactly as it does on the load error', async () => {
        armTransport({ error: 'HTTP 500' })
        armPermissions(false)
        armProbe('blocked')

        render(<App />)

        await waitFor(() => expect(permissionHeading()).toBeInTheDocument())
        expect(
            screen.queryByRole('button', { name: 'Open settings' }),
        ).not.toBeInTheDocument()
    })
})

describe('the half-working install: coupons load, but the content script is dead on every store', () => {
    it('renders no banner when the browser confirms the every-website grant', async () => {
        armTransport({ coupons: [{ code: 'SAVE10', status: 'valid' }] })
        armPermissions(true)

        render(<App />)

        await waitFor(() =>
            expect(screen.getByText(/Coupons for/)).toBeInTheDocument(),
        )
        expect(banner()).not.toBeInTheDocument()
        // The happy path must not spend a probe request: the successful coupon
        // fetch already proves the extension can reach the API, and
        // /api/extension/supported-stores is DB-backed and rate-limited.
        expect((globalThis as any).fetch).toBeUndefined()
    })

    it('renders the banner when coupons load on a NARROW grant, and its button asks for every website', async () => {
        armTransport({ coupons: [{ code: 'SAVE10', status: 'valid' }] })
        const { requestCalls } = armPermissions(false)

        render(<App />)

        await waitFor(() => expect(banner()).toBeInTheDocument())

        fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
        // Asserted WITHOUT awaiting: permissions.request() must be reached
        // inside the click's own call stack. Every browser rejects a request
        // that is not attributable to a user gesture, and a single `await`
        // ahead of it ends the gesture — so "it was called by the time the
        // click returned" is the property, not "it was called eventually".
        expect(requestCalls).toEqual([{ origins: ['https://*/*'] }])
    })

    it('re-resolves the popup when the grant is actually given, so the banner goes away without reopening', async () => {
        armTransport({ coupons: [{ code: 'SAVE10', status: 'valid' }] })
        // contains() says no, and the prompt says yes — the state the popup
        // must not be left holding.
        const granted = { value: false }
        chromeStub.permissions.contains = (_perms: unknown, cb: any) =>
            cb(granted.value)
        chromeStub.permissions.request = (_perms: unknown, cb: any) => {
            granted.value = true
            cb(true)
        }

        render(<App />)
        await waitFor(() => expect(banner()).toBeInTheDocument())

        fireEvent.click(screen.getByRole('button', { name: 'Enable' }))

        await waitFor(() => expect(banner()).not.toBeInTheDocument())
        expect(screen.getByText(/Coupons for/)).toBeInTheDocument()
    })
})

describe('Safari asks for a different pattern and can refuse the prompt outright', () => {
    it('asks for <all_urls>, the only pattern Safari counts as every website, and spells out the manual route', async () => {
        chromeStub.runtime.getURL = () => 'safari-web-extension://caramel/'
        expect(allSitesOriginPattern()).toBe('<all_urls>')

        armTransport({ error: 'HTTP 500' })
        const { requestCalls } = armPermissions(false)
        armProbe('blocked')

        render(<App />)
        await waitFor(() => expect(permissionHeading()).toBeInTheDocument())

        // Safari's request() can hand back a narrower grant than it was asked
        // for, or nothing at all, so the view carries the menus that always
        // work alongside the button.
        expect(
            screen.getByText(/Always Allow on Every Website/),
        ).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Enable Caramel' }))
        expect(requestCalls).toEqual([{ origins: ['<all_urls>'] }])
    })

    it('does not show the manual Safari route on a Chromium runtime', async () => {
        armTransport({ error: 'HTTP 500' })
        armPermissions(false)
        armProbe('blocked')

        render(<App />)
        await waitFor(() => expect(permissionHeading()).toBeInTheDocument())
        expect(
            screen.queryByText(/Always Allow on Every Website/),
        ).not.toBeInTheDocument()
    })
})

describe('the loading overlay centres its spinner', () => {
    /* jsdom does no layout, so the rendered position cannot be measured here.
       The defect was purely declarative — a column flex container with no
       alignment, which parks its single 28px child at the flex line's start,
       i.e. the top-left corner of an empty 420px panel — so the source is
       pinned instead (house style for layout that a unit runner cannot see). */
    const css = readFileSync(join(ROOT, 'public/assets/styles.css'), 'utf8')
    const loadingBlock = css.slice(
        css.indexOf('.loading-container {'),
        css.indexOf('}', css.indexOf('.loading-container {')),
    )

    it('centres on both axes', () => {
        expect(loadingBlock).toContain('align-items: center')
        expect(loadingBlock).toContain('justify-content: center')
    })

    it('no longer carries the column/gap left over from the multi-child skeleton', () => {
        expect(loadingBlock).not.toContain('flex-direction: column')
        expect(loadingBlock).not.toContain('gap:')
    })

    it('has no orphan .skeleton-header rule, and keeps the .skeleton rules CouponsView still renders', () => {
        expect(css).not.toContain('.skeleton-header')
        expect(css).toContain('.skeleton {')
        expect(css).toContain('.skeleton-ticket {')
    })
})
