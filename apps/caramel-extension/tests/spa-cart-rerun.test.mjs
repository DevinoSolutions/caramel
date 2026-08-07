import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    getOnMessageListeners,
    loadExtensionSource,
    loadExtensionSources,
} from './_load.mjs'

// Detection ran once, when the document loaded, and never again. On a store
// that rewrites its own address bar that is one evaluation too few.
//
// Measured live on 2026-08-06: toms.com navigates /cart to /?open_cart=true and
// then rewrites THAT to a bare / without a second navigation. The content
// script evaluated the page it landed on and nothing ever asked it again, so a
// shopper sitting in an open cart drawer got silence for the whole visit.
//
// Nothing inside the page reliably announces a same-document rewrite that the
// extension can hear without new permissions. The service worker's
// tabs.onUpdated listener already sees it — it just kept the news to itself.

describe('background: telling the page its URL moved', () => {
    let onTabUpdated
    let sent

    beforeAll(() => {
        globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
        ;({ _caramelOnTabUpdated: onTabUpdated } = loadExtensionSource(
            'background.js',
            ['_caramelOnTabUpdated'],
        ))
    })

    beforeEach(() => {
        sent = []
        globalThis.chrome.tabs.sendMessage = (tabId, message) => {
            sent.push({ tabId, message })
            // The real API rejects when the tab has no content script of ours.
            return Promise.reject(new Error('no receiving end'))
        }
    })

    it('tells the tab when the URL changed', () => {
        onTabUpdated(
            7,
            { url: 'https://store.example/' },
            {
                url: 'https://store.example/',
            },
        )

        expect(sent).toEqual([
            {
                tabId: 7,
                message: {
                    action: 'caramelUrlChanged',
                    url: 'https://store.example/',
                },
            },
        ])
    })

    it('says nothing on a plain load completion', () => {
        // `complete` fires on the same document the content script already
        // evaluated. Only a URL change is news.
        onTabUpdated(
            7,
            { status: 'complete' },
            { url: 'https://store.example/' },
        )

        expect(sent).toEqual([])
    })

    it('says nothing on an update that is neither', () => {
        onTabUpdated(
            7,
            { favIconUrl: 'https://store.example/f.ico' },
            {
                url: 'https://store.example/',
            },
        )

        expect(sent).toEqual([])
    })

    it('survives a tab with no content script to receive it', async () => {
        // Most tabs in the browser are one of these. An unhandled rejection
        // here would be a service-worker error on every ordinary navigation.
        expect(() =>
            onTabUpdated(
                7,
                { url: 'https://unrelated.example/' },
                {
                    url: 'https://unrelated.example/',
                },
            ),
        ).not.toThrow()
        await Promise.resolve()
    })
})

describe('content: re-answering the question when the URL moves', () => {
    let onMessage
    let runs

    beforeAll(() => {
        loadExtensionSources(
            [
                'coupon-constants.generated.js',
                'caramel-base.js',
                'dom-utils.js',
                'store-detect.js',
                'coupon-apply.js',
                'coupon-fetch.js',
                'coupon-runner.js',
            ],
            ['caramelHandleUrlChanged'],
        )
        ;[onMessage] = getOnMessageListeners()
    })

    beforeEach(() => {
        runs = []
        globalThis.startCheckoutDetection = async () => {
            runs.push(location.href)
        }
        globalThis._caramelEvaluatedUrls = new Set([location.href])
    })

    it('re-runs detection for a URL it has not answered for', () => {
        expect(
            caramelHandleUrlChanged('https://store.example/?open_cart=1'),
        ).toBe(true)

        expect(runs).toHaveLength(1)
    })

    it('does not re-run for the same URL twice', () => {
        caramelHandleUrlChanged('https://store.example/')
        expect(caramelHandleUrlChanged('https://store.example/')).toBe(false)

        expect(runs).toHaveLength(1)
    })

    it('does re-run for the next distinct URL', () => {
        caramelHandleUrlChanged('https://store.example/?open_cart=1')
        caramelHandleUrlChanged('https://store.example/')

        expect(runs).toHaveLength(2)
    })

    it('does not re-run for the URL the document already loaded at', () => {
        // inject.js has already run detection there.
        expect(caramelHandleUrlChanged(location.href)).toBe(false)

        expect(runs).toEqual([])
    })

    it('ignores an update carrying no URL', () => {
        expect(caramelHandleUrlChanged(undefined)).toBe(false)
        expect(caramelHandleUrlChanged('')).toBe(false)

        expect(runs).toEqual([])
    })

    it('is reached from the background message, and answers it', () => {
        let reply
        onMessage(
            { action: 'caramelUrlChanged', url: 'https://store.example/x' },
            {},
            r => {
                reply = r
            },
        )

        expect(runs).toHaveLength(1)
        expect(reply).toEqual({ success: true })
    })
})
