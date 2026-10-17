// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://grabcaramel.com/welcome?src=ext&store=chrome&v=1.4.6&iid=3f2b8c1e-5a47-4d6b-9e10-7c2d4a8b9f01"}
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { caramelCaptureInstallFirstTouch } from '../coupon-runner.js'
import { INSTALL_ATTRIBUTION_KEY } from '../install-attribution.js'

// The content-script half of install attribution: on the /welcome page the
// extension opened, copy the site's `cm_ft` cookie next to the stored install
// id. The site writes that cookie from its own client code, which may run
// AFTER this script, so the capture asks again (bounded) until the cookie is
// there. The jsdom URL above is the production welcome page, an allowlisted
// origin. Test doubles: caramel-base's browser handle (a storage object),
// `sleep` (records the gaps and lets the test write the cookie "later") and
// the log sinks.

const IID = '3f2b8c1e-5a47-4d6b-9e10-7c2d4a8b9f01'
const RECORD = {
    utm_source: 'reddit',
    landing_path: '/',
    captured_at: '2026-10-01T12:00:00.000Z',
}
const COOKIE_VALUE = encodeURIComponent(JSON.stringify(RECORD))

let stored
let sleeps
let logged
let onSleep

vi.mock('../caramel-base.js', async importOriginal => ({
    ...(await importOriginal()),
    currentBrowser: {
        runtime: { lastError: undefined },
        storage: {
            local: {
                get: (keys, cb) => {
                    const out = {}
                    for (const k of keys) if (k in stored) out[k] = stored[k]
                    cb(out)
                },
                set: (items, cb) => {
                    Object.assign(stored, items)
                    cb()
                },
            },
        },
    },
    sleep: async ms => {
        sleeps.push(ms)
        onSleep?.(sleeps.length)
    },
    log: (...args) => logged.push(['log', ...args]),
    logError: (...args) => logged.push(['logError', ...args]),
}))

function clearCookie() {
    document.cookie = 'cm_ft=; Max-Age=0; path=/'
}

beforeEach(() => {
    stored = { [INSTALL_ATTRIBUTION_KEY]: { iid: IID } }
    sleeps = []
    logged = []
    onSleep = undefined
    clearCookie()
})

describe('capturing the first touch on the welcome page', () => {
    it('saves the cookie that is already there, on the first try', async () => {
        document.cookie = `cm_ft=${COOKIE_VALUE}; path=/`

        expect(await caramelCaptureInstallFirstTouch()).toBe('saved')

        expect(stored[INSTALL_ATTRIBUTION_KEY]).toEqual({
            iid: IID,
            firstTouch: RECORD,
        })
        expect(sleeps).toEqual([])
    })

    it('waits for a cookie the page writes after us, then saves it', async () => {
        onSleep = count => {
            if (count === 2) document.cookie = `cm_ft=${COOKIE_VALUE}; path=/`
        }

        expect(await caramelCaptureInstallFirstTouch()).toBe('saved')

        expect(sleeps).toEqual([1500, 1500])
        expect(stored[INSTALL_ATTRIBUTION_KEY].firstTouch).toEqual(RECORD)
    })

    it('gives up after a bounded number of tries, and says so', async () => {
        expect(await caramelCaptureInstallFirstTouch()).toBe('no-cookie')

        expect(sleeps).toHaveLength(5)
        expect(stored[INSTALL_ATTRIBUTION_KEY]).toEqual({ iid: IID })
        expect(
            logged.some(
                ([kind, name]) =>
                    kind === 'log' && name === 'INSTALL_FIRST_TOUCH_ABSENT',
            ),
        ).toBe(true)
    })

    it('reports a corrupt cookie rather than treating it as absent', async () => {
        document.cookie = 'cm_ft=%7Bbroken; path=/'

        await caramelCaptureInstallFirstTouch()

        expect(
            logged.some(
                ([kind, name]) =>
                    kind === 'logError' &&
                    name === 'INSTALL_FIRST_TOUCH_COOKIE_INVALID',
            ),
        ).toBe(true)
    })

    it('does not retry once the answer is definite (already saved)', async () => {
        stored[INSTALL_ATTRIBUTION_KEY] = { iid: IID, firstTouch: RECORD }

        expect(await caramelCaptureInstallFirstTouch()).toBe('already')
        expect(sleeps).toEqual([])
    })
})
