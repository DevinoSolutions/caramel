// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://grabcaramel.com/"}
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { EXT_ROOT, installChromeStub } from './_load.mjs'

// Pins the website→extension sign-in relay (content-script side), which
// runs only on our own origins (CARAMEL_ALLOWED_ORIGINS):
//   1. session-less extension announces itself: window.postMessage
//      {type:'caramel-ext-hello'} to the page, same-origin target.
//   2. the page (signed in) answers with {token, username, image}; the
//      "message" listener stores it in storage.sync — but ONLY from an
//      allowlisted origin.
// The jsdom URL above puts this realm on https://grabcaramel.com, the one
// production origin in the allowlist.
//
// Load note: unlike the other suites, the files are evaluated as ONE
// concatenated script. The relay reads caramel-base.js's top-level
// `const CARAMEL_ALLOWED_ORIGINS` from coupon-runner.js — in a real
// browser all content scripts share one global lexical environment, but
// _load.mjs's per-file `(0, eval)` calls do not carry top-level consts
// across files (documented there), which would fail the lookup this test
// exists to exercise.
let stored
let posted

beforeAll(() => {
    posted = []
    stored = null
    window.postMessage = vi.fn((data, target) => {
        posted.push({ data, target })
    })

    installChromeStub()
    // The relayed session is stored in storage.LOCAL (it is a full website
    // session token and must not roam via Chrome Sync). Both areas answer an
    // empty read, so the extension still considers itself session-less and
    // sends the hello that starts the relay.
    globalThis.chrome.storage.local.get = (_keys, cb) => cb({})
    globalThis.chrome.storage.sync.get = (_keys, cb) => cb({})
    globalThis.chrome.storage.local.set = (items, cb) => {
        stored = items
        if (cb) cb()
    }

    const src = [
        'coupon-constants.generated.js',
        'caramel-base.js',
        'dom-utils.js',
        'store-detect.js',
        'coupon-apply.js',
        'coupon-fetch.js',
        'coupon-runner.js',
    ]
        .map(f => readFileSync(path.join(EXT_ROOT, f), 'utf8'))
        .join('\n;\n')
    ;(0, eval)(src)
})

describe('coupon-runner.js website→extension session relay', () => {
    it('announces itself with caramel-ext-hello on its own origin when no token is stored', () => {
        // The hello fires from the (synchronous, stubbed) storage.sync.get
        // callback during load above.
        const hello = posted.find(p => p.data?.type === 'caramel-ext-hello')
        expect(hello).toBeTruthy()
        expect(hello.target).toBe('https://grabcaramel.com')
    })

    it('stores a token posted from the page (allowlisted origin)', async () => {
        window.dispatchEvent(
            new MessageEvent('message', {
                origin: 'https://grabcaramel.com',
                data: { token: 'relayed-token', username: 'tester', image: '' },
            }),
        )
        await new Promise(r => setTimeout(r, 0))
        expect(stored).toMatchObject({
            token: 'relayed-token',
            user: { username: 'tester' },
        })
    })

    it('ignores a token posted from a foreign origin', async () => {
        stored = null
        window.dispatchEvent(
            new MessageEvent('message', {
                origin: 'https://evil.example.com',
                data: { token: 'stolen-session', username: 'attacker' },
            }),
        )
        await new Promise(r => setTimeout(r, 0))
        expect(stored).toBeNull()
    })
})
