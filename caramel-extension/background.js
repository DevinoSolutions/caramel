const currentBrowser = (() => {
    if (typeof chrome !== 'undefined') return chrome // Chrome and Chromium-based browsers
    if (typeof browser !== 'undefined') return browser // Firefox
    throw new Error('Browser is not supported!')
})()

// Keep-Alive Mechanism
function keepAlive() {
    setInterval(() => {
        console.log('Service worker is alive')
    }, 10000) // Logs every 10 seconds to indicate service worker is active
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
            const originalTab = sender.tab
            currentBrowser.tabs
                .create({
                    url: 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart',
                })
                .then(async amazonCartPage => {
                    await currentBrowser.scripting.executeScript({
                        target: { tabId: amazonCartPage.id },
                        files: ['shared-utils.js'],
                    })

                    const result = await currentBrowser.scripting.executeScript(
                        {
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
                                        ).map(element =>
                                            element.textContent.trim(),
                                        )
                                        const keywords = titles
                                            .join(' ')
                                            .split(' ')
                                        console.log('Keywords:', keywords)
                                        const filteredKeywords =
                                            await window.filterKeywords(
                                                keywords,
                                            )
                                        console.log(
                                            'Filtered Keywords:',
                                            filteredKeywords,
                                        )
                                        resolve(filteredKeywords)
                                    } catch (error) {
                                        reject(error)
                                    }
                                })
                            },
                        },
                    )
                    console.log('Amazon cart keywords:', result[0].result) // result is wrapped in an array
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
                        await currentBrowser.scripting.executeScript({
                            target: { tabId },
                            files: ['shared-utils.js'],
                        })
                        const [result] =
                            await currentBrowser.scripting.executeScript({
                                target: { tabId },
                                func: async () => {
                                    try {
                                        const hostname =
                                            window.location.hostname
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
