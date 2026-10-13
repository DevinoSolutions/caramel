import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Install attribution: on a FIRST install (runtime.onInstalled reason
// 'install') the worker opens <BASE_URL>/welcome?src=ext&store=..&v=..&iid=..
// in a new tab. An update (reason 'update') — or any other reason — opens
// nothing. The website half (apps/caramel-app/src/app/welcome +
// /api/ext/installed) parses exactly this URL, so the vocabulary and the
// patterns it enforces are read out of the app's own source below and the URL
// built here is checked against them: drift on either side is a red test.

const here = dirname(fileURLToPath(import.meta.url))
const appContract = readFileSync(
    join(here, '../../caramel-app/src/lib/extensionInstall.ts'),
    'utf8',
)

/** The `/pattern/flags` literal assigned to `name` in the app's contract file. */
function patternFromContract(name) {
    const match = appContract.match(
        new RegExp(`${name} =\\s*(/.+/[a-z]*)\\s*$`, 'm'),
    )
    if (!match) throw new Error(`${name} not found in extensionInstall.ts`)
    const literal = match[1]
    const end = literal.lastIndexOf('/')
    return new RegExp(literal.slice(1, end), literal.slice(end + 1))
}

function storesFromContract() {
    const match = appContract.match(/EXTENSION_STORES = \[([^\]]+)\] as const/)
    if (!match) throw new Error('EXTENSION_STORES not found')
    return match[1].split(',').map(s => s.trim().replaceAll("'", ''))
}

let onInstalled
let createdTabs
let tabCreateError
let detectStoreChannel
let welcomeUrl
let manifestVersion

// The worker realm background.js expects (see background.test.mjs for the
// reasoning): a permissive chrome Proxy plus ServiceWorkerGlobalScope. This is
// a TEST DOUBLE of the extension APIs — only onInstalled, tabs.create,
// getURL and getManifest carry behaviour.
function installWorkerRealm() {
    const cache = new WeakMap()
    const wrap = target => {
        if (cache.has(target)) return cache.get(target)
        const proxy = new Proxy(target, {
            get(obj, prop) {
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
        stub.storage[area].get = (_keys, cb) => cb?.({})
        stub.storage[area].set = (_items, cb) => cb?.()
        stub.storage[area].remove = (_keys, cb) => cb?.()
    }
    stub.runtime.lastError = undefined
    stub.runtime.onInstalled.addListener = fn => {
        onInstalled = fn
    }
    stub.runtime.getURL = () => 'chrome-extension://abcdef/'
    stub.runtime.getManifest = () => ({ version: manifestVersion })
    stub.tabs.create = (options, cb) => {
        createdTabs.push(options)
        stub.runtime.lastError = tabCreateError
        cb?.()
        stub.runtime.lastError = undefined
    }
    globalThis.ServiceWorkerGlobalScope = {
        [Symbol.hasInstance]: () => true,
    }
    globalThis.chrome = stub
    globalThis.browser = undefined
}

beforeAll(async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 })
    manifestVersion = '1.4.6'
    createdTabs = []
    installWorkerRealm()
    const background = await import('../background.js')
    ;({ detectStoreChannel, welcomeUrl } = background)
    background.initBackground()
})

beforeEach(() => {
    createdTabs.length = 0
    tabCreateError = undefined
})

describe('runtime.onInstalled', () => {
    it('registers an onInstalled listener', () => {
        expect(typeof onInstalled).toBe('function')
    })

    it('opens the welcome page in a new tab on a first install', () => {
        onInstalled({ reason: 'install' })
        expect(createdTabs).toHaveLength(1)
        const url = new URL(createdTabs[0].url)
        // Production stamp (vitest.config.ts): the production site.
        expect(url.origin).toBe('https://grabcaramel.com')
        expect(url.pathname).toBe('/welcome')
        expect(url.searchParams.get('src')).toBe('ext')
        expect(url.searchParams.get('store')).toBe('chrome')
        expect(url.searchParams.get('v')).toBe('1.4.6')
        expect(url.searchParams.get('iid')).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('mints a fresh install id per install', () => {
        onInstalled({ reason: 'install' })
        onInstalled({ reason: 'install' })
        const [a, b] = createdTabs.map(t =>
            new URL(t.url).searchParams.get('iid'),
        )
        expect(a).not.toBe(b)
    })

    it.each(['update', 'chrome_update', 'shared_module_update'])(
        'opens nothing on reason %s',
        reason => {
            onInstalled({ reason })
            expect(createdTabs).toHaveLength(0)
        },
    )

    it('opens nothing when called with no details at all', () => {
        onInstalled(undefined)
        expect(createdTabs).toHaveLength(0)
    })

    it('does not throw when the tab cannot be opened (the failure is logged, not raised)', () => {
        tabCreateError = { message: 'tabs.create refused' }
        expect(() => onInstalled({ reason: 'install' })).not.toThrow()
    })
})

describe('detectStoreChannel', () => {
    const chromeUa =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    const edgeUa = `${chromeUa} Edg/130.0.0.0`

    it('Firefox and Safari come from the runtime URL scheme', () => {
        expect(detectStoreChannel('moz-extension://x/', chromeUa)).toBe(
            'firefox',
        )
        expect(detectStoreChannel('safari-web-extension://x/', chromeUa)).toBe(
            'safari',
        )
    })

    it('Edge is the Chromium build with an Edg/ user agent; plain Chrome is chrome', () => {
        expect(detectStoreChannel('chrome-extension://x/', edgeUa)).toBe('edge')
        expect(detectStoreChannel('chrome-extension://x/', chromeUa)).toBe(
            'chrome',
        )
    })
})

describe('welcome URL contract with the website (src/lib/extensionInstall.ts)', () => {
    const versionPattern = patternFromContract('EXTENSION_VERSION_PATTERN')
    const iidPattern = patternFromContract('INSTALL_ID_PATTERN')
    const stores = storesFromContract()

    it('the app accepts exactly the four stores the extension can report', () => {
        expect(stores).toEqual(['chrome', 'firefox', 'edge', 'safari'])
        for (const [scheme, ua, expected] of [
            ['chrome-extension://x/', 'Chrome/1', 'chrome'],
            ['chrome-extension://x/', 'Edg/1', 'edge'],
            ['moz-extension://x/', 'Firefox/1', 'firefox'],
            ['safari-web-extension://x/', 'Safari/1', 'safari'],
        ]) {
            expect(stores).toContain(detectStoreChannel(scheme, ua))
            expect(detectStoreChannel(scheme, ua)).toBe(expected)
        }
    })

    it('the version and install id it sends satisfy the website patterns', () => {
        onInstalled({ reason: 'install' })
        const url = new URL(createdTabs[0].url)
        expect(url.searchParams.get('v')).toMatch(versionPattern)
        expect(url.searchParams.get('iid')).toMatch(iidPattern)
    })

    it('welcomeUrl carries exactly src, store, v and iid', () => {
        const url = new URL(
            welcomeUrl(
                'firefox',
                '1.4.6',
                'f81d4fae-7dec-41d0-a765-00a0c91e6bf6',
            ),
        )
        expect([...url.searchParams.keys()].toSorted()).toEqual([
            'iid',
            'src',
            'store',
            'v',
        ])
    })
})
