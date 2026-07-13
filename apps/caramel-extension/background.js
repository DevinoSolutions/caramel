const currentBrowser = (() => {
    if (typeof chrome !== 'undefined') return chrome // Chrome and Chromium-based browsers
    if (typeof browser !== 'undefined') return browser // Firefox
    throw new Error('Browser is not supported!')
})()

// Dev detection WITHOUT the `management` permission: packed Chrome Web Store
// builds carry an `update_url` in the manifest; unpacked dev installs don't.
// This is synchronous, so the base URL is correct before the first message is
// handled (the old chrome.management.getSelf callback raced inbound messages).
const _isDevInstall = () => {
    try {
        return !currentBrowser.runtime.getManifest().update_url
    } catch {
        return false
    }
}
// Unpacked/dev installs hit the DEV deployment (dev.grabcaramel.com); the
// packed Web Store build (has update_url) hits production.
globalThis.CARAMEL_BASE_URL = _isDevInstall()
    ? 'https://dev.grabcaramel.com'
    : 'https://grabcaramel.com'
const caramelUrl = path =>
    new URL(path, `${globalThis.CARAMEL_BASE_URL}/`).toString()

const FETCH_TIMEOUT_MS = 8000
function fetchWithTimeout(url, opts = {}) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() =>
        clearTimeout(timer),
    )
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
        } catch {
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
        if (!message || typeof message.action !== 'string') return
        if (message.action === 'openPopup') {
            currentBrowser.windows.create({
                url: currentBrowser.runtime.getURL(
                    'index.html?isPopup=true&callerId=' +
                        (sender.tab?.id ?? ''),
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
            sendResponse({ status: 'alive' }) // Respond to the message
        } else if (message.action === 'classifyCart') {
            fetchWithTimeout(caramelUrl('api/classify-cart'), {
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
            if (_isDevInstall())
                console.log('BACKGROUND: fetchCoupons', {
                    site,
                    kw,
                    url: url.toString(),
                    t: Date.now(),
                })
            fetchWithTimeout(url.toString())
                .then(async r => {
                    if (!r.ok) return { error: `HTTP ${r.status}` }
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
            fetchWithTimeout(url)
                .then(async r => {
                    if (!r.ok) return { error: `HTTP ${r.status}` }
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
        } else {
            // Unknown action — respond so the caller's promise never hangs.
            sendResponse({ error: 'unknown_action' })
        }
    },
)
