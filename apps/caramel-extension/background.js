const currentBrowser = (() => {
    if (typeof chrome !== 'undefined') return chrome // Chrome and Chromium-based browsers
    if (typeof browser !== 'undefined') return browser // Firefox
    throw new Error('Browser is not supported!')
})()

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
            // Received keep-alive message from content script
            sendResponse({ status: 'alive' }) // Respond to the message
        } else if (message.action === 'scrapeAmazonCartKeywords') {
            const originalTab = sender.tab
            currentBrowser.tabs
                .create({
                    url: 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart',
                })
                .then(async amazonCartPage => {
                    await execScript({
                        target: { tabId: amazonCartPage.id },
                        files: ['shared-utils.js', 'UI-helpers.js'],
                    })

                    const result = await execScript({
                        target: { tabId: amazonCartPage.id },
                        func: async () => {
                            window.showTestingModal(
                                'Fetching coupon keywords...',
                                true,
                            )
                            return new Promise(async (resolve, reject) => {
                                try {
                                    const productTitleElements =
                                        document.querySelectorAll(
                                            '.sc-product-title',
                                        )
                                    const titles = Array.from(
                                        productTitleElements,
                                    ).map(element => element.textContent.trim())
                                    const keywords = titles.join(' ').split(' ')
                                    // Keywords: keywords
                                    const filteredKeywords =
                                        await window.filterKeywords(keywords)
                                    // Filtered Keywords: filteredKeywords
                                    resolve(filteredKeywords)
                                } catch (error) {
                                    reject(error)
                                }
                            })
                        },
                    })
                    // Amazon cart keywords: result[0].result
                    sendResponse({ keywords: result[0].result }) // Send filtered keywords as respons
                    currentBrowser.tabs.remove(amazonCartPage.id)
                    currentBrowser.tabs.update(originalTab.id, { active: true })
                })
                .catch(error => {
                    console.error('Error during Amazon cart scraping:', error)
                    sendResponse({ error: 'Failed to scrape Amazon cart' })
                })
            return true
        } else if (message.action === 'getActiveTabDomainRecord') {
            currentBrowser.tabs.query(
                { active: true, lastFocusedWindow: true },
                async tabs => {
                    if (!tabs || !tabs.length) {
                        sendResponse({ domainRecord: null, url: null })
                        return
                    }

                    const tabId = tabs[0].id

                    try {
                        await execScript({
                            target: { tabId },
                            files: ['shared-utils.js', 'UI-helpers.js'],
                        })
                        const [result] = await execScript({
                            target: { tabId },
                            func: async () => {
                                try {
                                    const hostname = window.location.hostname
                                    return { url: hostname }
                                } catch (err) {
                                    console.error(
                                        'Error while getting domain record:',
                                        err,
                                    )
                                    return null
                                }
                            },
                        })
                        const { domainRecord, url } = result?.result || null
                        sendResponse({ domainRecord, url })
                    } catch (err) {
                        console.error(
                            'Error injecting or executing domain-record script:',
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
