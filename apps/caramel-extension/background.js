const currentBrowser = (() => {
    if (typeof chrome !== 'undefined') return chrome // Chrome and Chromium-based browsers
    if (typeof browser !== 'undefined') return browser // Firefox
    throw new Error('Browser is not supported!')
})()

globalThis.CARAMEL_BASE_URL = 'https://grabcaramel.com'
const EXTENSION_API_KEY = 'WXqEpm2uOV5jjJXPpnQFyZiNdaPVUrtd2LIrf4kc1JA'
const caramelUrl = path =>
    new URL(path, `${globalThis.CARAMEL_BASE_URL}/`).toString()

// Auto-switch to localhost when loaded as unpacked dev extension
if (typeof chrome !== 'undefined' && chrome.management) {
    chrome.management.getSelf(info => {
        if (info?.installType === 'development') {
            globalThis.CARAMEL_BASE_URL = 'http://localhost:58000'
            console.log('[caramel] DEV MODE: API → localhost:58000')
        }
    })
}

function isServiceWorkerContext() {
    return (
        typeof ServiceWorkerGlobalScope !== 'undefined' &&
        self instanceof ServiceWorkerGlobalScope
    )
}

// Detect if we're in a service worker context or traditional background script
// This is needed to support Firefox (MV2) and Chromium/Safari browsers (MV3)
const isServiceWorker = isServiceWorkerContext()
const hasTabsExecute = !!(
    currentBrowser.tabs && currentBrowser.tabs.executeScript
)

function execScript(details) {
    if (isServiceWorker || !hasTabsExecute) {
        return currentBrowser.scripting.executeScript(details)
    }
    const {
        target: { tabId },
        files,
        func,
    } = details // MV2 fallback (For Firefox)
    if (files && files.length) {
        return files.reduce(
            (p, f) =>
                p.then(() =>
                    currentBrowser.tabs.executeScript(tabId, { file: f }),
                ),
            Promise.resolve(),
        )
    }
    return currentBrowser.tabs.executeScript(tabId, { code: `(${func})();` })
}

// NOTE: Do not use `execScript` to inject full content-script bundles
// that are declared in `manifest.json` (e.g. `shared-utils.js`).
// Injecting the same bundle twice into the same isolated world can
// cause redeclaration errors for top-level `const`/`let`/`class`.
// Prefer `tabs.query` for URL-only needs, or `tabs.sendMessage` to
// message an already-loaded content script for DOM reads.

function waitForTabComplete(tabId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            currentBrowser.tabs.onUpdated.removeListener(onUpdated)
            reject(new Error('Timed out waiting for tab to load'))
        }, timeoutMs)

        function onUpdated(updatedTabId, changeInfo) {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                clearTimeout(timer)
                currentBrowser.tabs.onUpdated.removeListener(onUpdated)
                resolve()
            }
        }

        currentBrowser.tabs.onUpdated.addListener(onUpdated)
    })
}

function sendMessageToTab(tabId, msg, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('sendMessage timeout')),
            timeoutMs,
        )

        currentBrowser.tabs.sendMessage(tabId, msg, resp => {
            clearTimeout(timer)
            const err = currentBrowser.runtime.lastError
            if (err) return reject(err)
            resolve(resp)
        })
    })
}

// Keep-Alive Mechanism
function keepAlive() {
    if (isServiceWorker) {
        // For service workers, use chrome.alarms to keep alive
        try {
            currentBrowser.alarms.create('keepAlive', { periodInMinutes: 1 })

            currentBrowser.alarms.onAlarm.addListener(alarm => {
                if (alarm.name === 'keepAlive') {
                    // Service worker is alive - periodic check
                }
            })
        } catch (error) {
            // Fallback if alarms API is not available
        }
    } else {
        // For traditional background scripts, use setInterval
        setInterval(() => {
            // Background script is alive - periodic check
        }, 10000) // Check every 10 seconds
    }
}

keepAlive()

currentBrowser.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {
        if (message.action === 'openPopup') {
            currentBrowser.windows.create({
                url: currentBrowser.runtime.getURL(
                    'index.html?isPopup=true&callerId=' + sender.tab.id,
                ),
                type: 'popup',
                width: 400,
                height: 450,
            })
            sendResponse({ success: true })
        } else if (message.action.startsWith('userLoggedInFromPopup_')) {
            const callerId = message.action.split('_')[1]
            currentBrowser.tabs.sendMessage(parseInt(callerId), {
                action: 'userLoggedIn',
            })
            sendResponse({ success: true })
        } else if (message.action === 'keepAlive') {
            console.log('Received keep-alive message from content script')
            sendResponse({ status: 'alive' }) // Respond to the message
        } else if (message.action === 'scrapeAmazonCartKeywords') {
            const originalTabId = sender?.tab?.id
            try {
                console.log('AUTO_INSERT_AMAZON_SCRAPE_START', {
                    originalTabId,
                    t: performance.now(),
                })
            } catch (e) {}
            currentBrowser.tabs
                .create({
                    url: 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart',
                    active: false,
                })
                .then(async cartTab => {
                    try {
                        await waitForTabComplete(cartTab.id)

                        const resp = await sendMessageToTab(cartTab.id, {
                            action: 'caramel:scrapeAmazonCartKeywordsFromCart',
                        })

                        try {
                            console.log('AUTO_INSERT_AMAZON_SCRAPE_END', {
                                count: (resp?.keywords || []).length,
                                t: performance.now(),
                            })
                        } catch (e) {}

                        sendResponse({ keywords: resp?.keywords || [] })
                    } catch (error) {
                        console.error(
                            'Error during Amazon cart scraping:',
                            error,
                        )
                        try {
                            console.log('AUTO_INSERT_AMAZON_SCRAPE_ERROR', {
                                error: String(error),
                                t: performance.now(),
                            })
                        } catch (e) {}
                        sendResponse({
                            keywords: [],
                            error: 'Failed to scrape Amazon cart',
                        })
                    } finally {
                        if (cartTab?.id) currentBrowser.tabs.remove(cartTab.id)
                        if (originalTabId)
                            currentBrowser.tabs.update(originalTabId, {
                                active: true,
                            })
                    }
                })
                .catch(error => {
                    console.error('Error creating Amazon cart tab:', error)
                    sendResponse({
                        keywords: [],
                        error: 'Failed to open Amazon cart',
                    })
                })

            return true
        } else if (message.action === 'classifyCart') {
            fetch(caramelUrl('api/classify-cart'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(message.signals || {}),
            })
                .then(async r => {
                    if (!r.ok) return { error: `HTTP ${r.status}` }
                    return r.json()
                })
                .then(resp => sendResponse(resp))
                .catch(err => {
                    console.error('classifyCart error', err)
                    sendResponse({ error: String(err) })
                })

            return true
        } else if (message.action === 'fetchCoupons') {
            const { site, kw, category } = message
            const url = new URL(caramelUrl('api/coupons'))
            url.searchParams.set('site', site)
            url.searchParams.set('key_words', kw || '')
            url.searchParams.set('limit', '20')
            if (category) url.searchParams.set('category', category)
            console.log('BACKGROUND: fetchCoupons', {
                site,
                kw,
                url: url.toString(),
                t: Date.now(),
            })
            fetch(url.toString())
                .then(async r => {
                    if (!r.ok) return { coupons: [] }
                    const json = await r.json()
                    return {
                        coupons: Array.isArray(json)
                            ? json
                            : json.coupons || [],
                    }
                })
                .then(resp => sendResponse(resp))
                .catch(err => sendResponse({ coupons: [], error: String(err) }))

            return true
        } else if (message.action === 'fetchSupportedStores') {
            const url = caramelUrl('api/extension/supported-stores')
            fetch(url, {
                headers: { 'x-api-key': EXTENSION_API_KEY },
            })
                .then(async r => {
                    if (!r.ok) return { supported: [] }
                    return r.json()
                })
                .then(resp => sendResponse(resp))
                .catch(err => {
                    console.error('fetchSupportedStores error', err)
                    sendResponse({ supported: [], error: String(err) })
                })

            return true
        } else if (message.action === 'getActiveTabDomainRecord') {
            currentBrowser.tabs.query(
                { active: true, lastFocusedWindow: true },
                tabs => {
                    if (!tabs || !tabs.length) {
                        sendResponse({ domainRecord: null, url: null })
                        return
                    }

                    const tab = tabs[0]
                    const tabUrl = tab.url || ''

                    // Don't inject into extension pages (popup, options, etc.)
                    if (
                        tabUrl.startsWith('chrome-extension://') ||
                        tabUrl.startsWith('moz-extension://') ||
                        tabUrl.startsWith('safari-web-extension://')
                    ) {
                        // For extension pages, just return the URL without injecting
                        try {
                            const url = new URL(tabUrl)
                            sendResponse({
                                domainRecord: null,
                                url: url.hostname,
                            })
                        } catch {
                            sendResponse({ domainRecord: null, url: null })
                        }
                        return
                    }

                    // Content scripts are injected by manifest. Use tab URL directly
                    // to avoid reinjection and duplicate declaration errors.
                    try {
                        const hostname = tabUrl
                            ? new URL(tabUrl).hostname
                            : null
                        sendResponse({ domainRecord: null, url: hostname })
                    } catch (err) {
                        console.error(
                            'Error getting hostname from tab URL:',
                            err,
                        )
                        sendResponse({ domainRecord: null, url: null })
                    }
                },
            )

            return true
        }
    },
)
