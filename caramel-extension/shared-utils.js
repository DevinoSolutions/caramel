const currentBrowser = (() => {
    if (typeof chrome !== 'undefined') return chrome
    if (typeof browser !== 'undefined') return browser
    throw new Error('Browser is not supported!')
})()
async function isCheckout() {
    const domain = window.location.hostname
    console.log('Caramel: Current domain', domain)

    const domainRecord = await getDomainRecord(domain)
    console.log('Caramel: Domain record', domainRecord)
    if (!domainRecord) return
    try {
        await Promise.race([
            waitForDomUpdate(domainRecord.couponInput),
            waitForDomUpdate(domainRecord.showInput),
        ])
    } catch (err) {
        console.error('Caramel: Timed out or error:', err)
    }
    const input = document.querySelector(domainRecord.couponInput)
    const showInputButton = document.querySelector(domainRecord.showInput)
    return input || showInputButton
}
async function tryInitialize() {
    if (await isCheckout()) {
        const domain = window.location.hostname
        const domainRecord = await getDomainRecord(domain)
        await initCouponFlow(domainRecord)
    }
}

async function initCouponFlow(domainRecord) {
    // Insert a small button/prompt for the user to click
    console.log('Caramel: Inserting prompt for coupons...')
    await insertCaramelPrompt(domainRecord)
}

async function insertCaramelPrompt(domainRecord) {
    // Avoid inserting the prompt more than once
    if (document.getElementById('caramel-small-prompt')) {
        return
    }
    const container = document.createElement('div')
    container.id = 'caramel-small-prompt'

    container.style.position = 'fixed'
    container.style.top = '60px'
    container.style.right = '20px'
    container.style.zIndex = '999999'
    container.style.background = '#ea6925'
    container.style.padding = '20px'
    container.style.borderRadius = '12px'
    container.style.boxShadow = '0 4px 10px rgba(0, 0, 0, 0.3)'
    container.style.cursor = 'pointer'
    container.style.color = 'white'
    container.style.fontFamily = 'Arial, sans-serif'
    container.style.fontSize = '16px'
    container.style.textAlign = 'center'
    container.style.animation = 'fadeIn 0.5s ease-in-out, bounce 2s infinite'
    const logoUrl = await currentBrowser.runtime.getURL('assets/logo-light.png')
    container.innerHTML = `
    <div style="font-weight: bold;display: flex;justify-content: center">
        <img style="width: 30px;height: 30px;margin-top: auto;margin-bottom: auto" src="${logoUrl}" alt="logo"/>
        <div style="margin-top: auto;margin-bottom: auto;padding-top: 5px">Try Caramel Coupons? </div>
     </div><br>
      <button id="caramel-close-btn" style="
            background: none; 
            position: absolute;
            top: -5px;
            right: -5px;
            width: 20px;
            height: 20px;
            padding: 1px;
            border-radius: 50%;
            background: white;
            color: #ea6925;
            border: none; 
            font-size: 18px; 
            cursor: pointer; 
            margin-left: 10px;
        ">×</button>
    <small style="font-size: 14px;">Save more with automatic coupons!</small>
`

    const style = document.createElement('style')
    style.textContent = `
    @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
    }
    @keyframes bounce {
        0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
        40% { transform: translateY(-10px); }
        60% { transform: translateY(-5px); }
    }
`
    document.head.appendChild(style)

    container.addEventListener('click', event => {
        if (event.target.id === 'caramel-close-btn') {
            // If the close button is clicked, just remove the popup
            document.body.removeChild(container)
            return
        }
        // If the container itself is clicked, start applying coupons
        startApplyingCoupons(domainRecord)
        document.body.removeChild(container)
    })

    document.body.appendChild(container)
}

function getPrice(selector, options = {}) {
    const priceEl = document.querySelector(selector)
    if (!priceEl) {
        return NaN
    }

    const text = priceEl.innerText

    const currencyRegex =
        /\b(?:[A-Z]{1,3}\s?\$|\$|£|€)\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?\b/gi

    const matches = text.match(currencyRegex)
    if (!matches || matches.length === 0) {
        return NaN
    }
    const prices = matches.map(m => {
        const clean = m
            .replace(/[^0-9.,]/g, '') // remove everything but digits, commas, dots
            .replace(/,/g, '') // remove commas
        return parseFloat(clean)
    })
    if (options.returnLargest) {
        return Math.max(...prices)
    } else {
        return prices[0]
    }
}

async function applyCoupon(code, domainRecord, best = false) {
    try {
        // 1) Dismiss any active coupon pop-up/modal if present
        if (domainRecord.dismissButton) {
            console.log('Caramel: Dismissing coupon pop-up or modal')
            const dismissButton = document.querySelector(
                domainRecord.dismissButton,
            )
            if (dismissButton) {
                dismissButton.click()
                // Allow time for the dismissal to take effect
                await new Promise(resolve => setTimeout(resolve, 500))
            } else {
                console.warn('Caramel: Dismiss button not found.')
            }
        }

        // Allow UI to settle after a possible dismiss
        await new Promise(resolve => setTimeout(resolve, 500))

        const originalPrice = getPrice(domainRecord.priceContainer)
        console.log('Caramel: Original price is:', originalPrice)

        // 2) Identify coupon input and the button to show it if needed
        let promoInput = document.querySelector(domainRecord.couponInput)
        let showInput = document.querySelector(domainRecord.showInput)

        console.log('Caramel: Promo input:', promoInput)
        console.log('Caramel: Show input button:', showInput)

        // 3) If promo input isn't visible but a "show input" button exists, click it.
        if (!promoInput && showInput) {
            console.log("Caramel: Clicking 'show input' to reveal coupon field")
            showInput.click()

            // Wait for the coupon input to appear (up to 5 seconds)
            try {
                await waitForDomUpdate(domainRecord.couponInput, {
                    timeout: 5000,
                })
            } catch (err) {
                console.warn(
                    'Caramel: Timed out waiting for coupon input to appear:',
                    err,
                )
            }
            promoInput = document.querySelector(domainRecord.couponInput)
        }

        // 4) Ensure we have both the coupon input and apply button
        const applyButton = document.querySelector(domainRecord.couponSubmit)
        if (!promoInput || !applyButton) {
            console.warn('Caramel: Missing promo input or apply button.')
            return { success: false, newTotal: NaN }
        }

        // 5) Insert the coupon code and dispatch an 'input' event
        promoInput.value = code
        promoInput.dispatchEvent(new Event('input', { bubbles: true }))

        // 6) Click the apply button
        applyButton.click()

        // 7) Wait for the price container to update (up to 5 seconds)
        try {
            await waitForDomUpdate(domainRecord.priceContainer, {
                timeout: 5000,
            })
        } catch (err) {
            console.warn('Caramel: Timed out waiting for price update:', err)
        }

        // 8) Grab the new price
        const newPrice = getPrice(domainRecord.priceContainer)
        console.log('Caramel: New price is:', newPrice)

        // 9) Compare prices. If the new price isn’t lower, the coupon failed.
        if (isNaN(newPrice) || newPrice >= originalPrice) {
            return { success: false, newTotal: NaN }
        }

        return { success: true, newTotal: newPrice }
    } catch (err) {
        console.error('Caramel: Unexpected error in applyCoupon:', err)
        return { success: false, newTotal: NaN }
    }
}

async function getCoupons(domainRecord, noKeyWords = false) {
    console.log('Caramel: Fetching coupons for', domainRecord.domain)
    let keywords = ''
    if (domainRecord.domain === 'amazon.com' && !noKeyWords) {
        const response = await new Promise(resolve => {
            currentBrowser.runtime.sendMessage(
                { action: 'scrapeAmazonCartKeywords' },
                response => {
                    resolve(response)
                },
            )
        })
        keywords = response.keywords.join(',')
        console.log('Caramel: Keywords from Amazon cart:', keywords)
    }
    console.log(
        'Caramel: Fetching coupons for',
        domainRecord.domain,
        'with keywords:',
        keywords,
    )
    return await fetchCoupons(domainRecord.domain, keywords)
}

async function startApplyingCoupons(domainRecord) {
    await showTestingModal()

    // const token = await new Promise((resolve) => {
    //     currentBrowser.storage.sync.get(["token"], (result) => {
    //         resolve(result.token || "");
    //     });
    // });
    // console.log("Caramel: Token from storage:", token);
    // if (!token) {
    //     hideTestingModal();
    //     await showFinalModal(0, null, "Please sign in to Caramel to use coupons!", true);
    //     return;
    // }

    const coupons = await getCoupons(domainRecord)
    if (!coupons || coupons.length === 0) {
        showFinalModal(
            0,
            null,
            'No better price found. This is already the best you can get!',
        )
        return
    }

    let bestDifference = 0
    let bestCoupon = null
    // Store the original total to compare against
    const originalTotal = getPrice(domainRecord.priceContainer)

    // 4) Apply each coupon in turn
    for (let i = 0; i < coupons.length; i++) {
        const code = coupons[i].code
        await updateTestingModal(i + 1, coupons.length, code)

        const result = await applyCoupon(code, domainRecord)

        // Clear coupon input if it exists so the next coupon starts with a fresh state.
        const input = document.querySelector(domainRecord.couponInput)
        if (input) {
            input.value = ''
            input.dispatchEvent(new Event('input', { bubbles: true }))
        }

        // Give a short pause between coupon attempts.
        await new Promise(resolve => setTimeout(resolve, 1000))

        if (!result.success) {
            console.log(
                `Caramel: Coupon ${code} not successfully applied (or no discount field)`,
            )
        } else {
            const numericNewTotal = parseFloat(result.newTotal)
            const difference = originalTotal - numericNewTotal
            console.log(
                `Caramel: Applied ${code}, new total = ${numericNewTotal}, difference = ${difference}`,
            )
            if (bestCoupon === null || difference > bestDifference) {
                bestDifference = difference
                bestCoupon = coupons[i]
            }
        }
    }

    // 5) If we found a best coupon, reapply it
    if (bestCoupon) {
        console.log(
            'Caramel: Best coupon code:',
            bestCoupon.code,
            'Saved:',
            bestDifference,
        )
        console.log('Applying best coupon...')
        const result = await applyCoupon(bestCoupon.code, domainRecord, true)
        if (result.success) {
            console.log(
                'Caramel: Best coupon code applied:',
                bestCoupon.code,
                'Saved:',
                bestDifference,
            )
            showFinalModal(
                bestDifference,
                bestCoupon.code,
                'We found a coupon that saves you money!',
            )
        } else {
            showFinalModal(
                0,
                null,
                'No better price found. This is already the best you can get!',
            )
        }
    } else {
        showFinalModal(
            0,
            null,
            'No better price found. This is already the best you can get!',
        )
    }
}

async function fetchCoupons(site, keywords) {
    const url = `https://grabcaramel.com/api/coupons?site=${site}&key_words=${encodeURIComponent(keywords)}&limit=20`
    try {
        // const token = await new Promise((resolve) => {
        //     currentBrowser.storage.sync.get(["token"], (result) => {
        //         resolve(result.token || "");
        //     });
        // });
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                // Authorization: `Bearer ${token}`,
            },
        })
        if (!response.ok) {
            console.error(
                'Caramel: Error fetching coupons:',
                response.status,
                response.statusText,
            )
            return []
        }
        return await response.json()
    } catch (error) {
        console.error('Caramel: Fetch error:', error)
        return []
    }
}

async function showTestingModal(title = '', noLoading = false) {
    // Create overlay
    const overlay = document.createElement('div')
    overlay.id = 'caramel-testing-overlay'
    overlay.style.position = 'fixed'
    overlay.style.top = '0'
    overlay.style.left = '0'
    overlay.style.width = '100vw'
    overlay.style.height = '100vh'
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.6)'
    overlay.style.zIndex = '1000000'
    overlay.style.display = 'flex'
    overlay.style.justifyContent = 'center'
    overlay.style.alignItems = 'center'

    // Create the modal container
    const modal = document.createElement('div')
    modal.id = 'caramel-testing-modal'

    // Main modal styling
    modal.style.position = 'relative'
    modal.style.backgroundColor = '#ea6925' // Brand color
    modal.style.padding = '20px'
    modal.style.borderRadius = '12px'
    modal.style.boxShadow = '0 4px 10px rgba(0, 0, 0, 0.3)'
    modal.style.color = 'white'
    modal.style.width = '320px'
    modal.style.fontFamily = 'Arial, sans-serif'
    modal.style.textAlign = 'center'
    modal.style.animation = 'fadeIn 0.5s ease-in-out, bounce 2s infinite'

    // Fetch the Caramel logo
    const logoUrl = currentBrowser.runtime.getURL('assets/logo-light.png')

    const loadingHTML = ` <p id="caramel-test-status" style="margin: 10px 0; font-size: 15px;">Loading...</p>
    
    <!-- Progress bar container -->
    <div id="caramel-progress-container" style="
      background: rgba(255, 255, 255, 0.2);
      border-radius: 6px;
      width: 100%;
      height: 10px;
      margin: 10px 0;
      position: relative;
      overflow: hidden;
    ">
      <!-- The actual progress bar -->
      <div id="caramel-progress-bar" style="
        background: #ffbf47; /* A slightly lighter brand tone or accent color */
        width: 0%;
        height: 100%;
        border-radius: 6px;
        transition: width 0.3s ease;
      "></div>
    </div>`
    modal.innerHTML = `
    <div style="display: flex; justify-content: center; align-items: center; margin-bottom: 10px;">
      <img src="${logoUrl}" alt="Caramel Logo" style="width: 40px; height: 40px; margin-right: 8px;" />
      <h2 style="margin: 0; font-size: 18px;text-align: center">
        ${title ? title : 'Applying Coupons...'}
        </h2>
    </div>
   ${noLoading ? '' : loadingHTML}`

    // Add keyframe animations
    const style = document.createElement('style')
    style.textContent = `
  @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
  }
  @keyframes bounce {
      0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
      40% { transform: translateY(-10px); }
      60% { transform: translateY(-5px); }
  }
  `
    document.head.appendChild(style)

    // Append modal to overlay, and overlay to body
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
}

/**
 * Updates the "Testing Coupons" modal:
 *  - Changes the status text
 *  - Updates the progress bar width based on current vs total
 */
async function updateTestingModal(currentIndex, total, code) {
    // Update status text
    const statusEl = document.getElementById('caramel-test-status')
    if (statusEl) {
        statusEl.textContent = `Trying coupon ${currentIndex} of ${total} (${code})...`
    }

    // Update progress bar
    const progressBar = document.getElementById('caramel-progress-bar')
    if (progressBar && total > 0) {
        const progressPercent = Math.round((currentIndex / total) * 100)
        progressBar.style.width = `${progressPercent}%`
    }
}
function hideTestingModal() {
    const overlay = document.getElementById('caramel-testing-overlay')
    if (overlay) {
        document.body.removeChild(overlay)
    }
}

async function showFinalModal(savingsAmount, code, message, isSignIn = false) {
    hideTestingModal()
    // Create overlay
    const overlay = document.createElement('div')
    overlay.id = 'caramel-final-overlay'
    overlay.style.position = 'fixed'
    overlay.style.top = '0'
    overlay.style.left = '0'
    overlay.style.width = '100vw'
    overlay.style.height = '100vh'
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.7)'
    overlay.style.zIndex = '1000000'
    overlay.style.display = 'flex'
    overlay.style.justifyContent = 'center'
    overlay.style.alignItems = 'center'

    // Create the modal
    const modal = document.createElement('div')
    modal.style.backgroundColor = '#fff'
    modal.style.padding = '30px'
    modal.style.borderRadius = '12px'
    modal.style.width = '400px' // Increased width
    modal.style.boxShadow = '0 4px 15px rgba(0, 0, 0, 0.4)'
    modal.style.fontFamily = 'Arial, sans-serif'
    modal.style.textAlign = 'center'
    modal.style.position = 'relative'

    // Determine if user saved money
    const isSuccess = savingsAmount > 0

    // If no savings found, encourage the user that it's already the best price
    const defaultMessage = isSuccess
        ? `We found a coupon that saves you $${savingsAmount.toFixed(2)}!`
        : "Looks like you're already getting the best deal. Go ahead and buy!"

    // You can decide whether to use `message` or `defaultMessage` or combine them
    const finalMessage = message || defaultMessage

    // Caramel brand/logo
    const brandColor = '#ea6925'
    const logoUrl = currentBrowser.runtime.getURL('assets/logo.png') // Adjust if needed

    // Modal inner HTML
    modal.innerHTML = `
    <!-- Logo Section -->
    <div style="display: flex; justify-content: center; margin-bottom: 10px;">
      <img 
        src="${logoUrl}" 
        alt="Caramel Logo" 
        style="width: 60px; height: 60px;" 
      />
    </div>

    <!-- Heading/Text Section -->
    <h2 style="
      margin: 0 0 15px 0; 
      color: ${brandColor}; 
      font-size: 24px; 
      font-weight: bold;
    ">
      ${isSuccess ? '🎉 Savings Found! 🎉' : isSignIn ? 'Oups..' : 'Great News!'}
    </h2>
    <p style="font-size: 13px; color: #333; margin: 0 0 10px 0;">
      ${finalMessage}
    </p>
    
    <!-- If user saved money, show how much -->
    ${
        isSuccess
            ? `
            <p style="font-size: 24px;">
            Coupon: <span style="color: ${brandColor}; text-decoration: underline;font-weight: bold;">${code}</span>
          </p>
            <p style="font-size: 18px; color: ${brandColor}; font-weight: bold;">
            You saved $${savingsAmount.toFixed(2)}!
          </p>`
            : ''
    }
    
    <button 
      id="caramel-final-ok-btn" 
      style="
        margin-top: 20px; 
        background: ${brandColor}; 
        border: none; 
        color: #fff; 
        padding: 12px 24px; 
        border-radius: 8px; 
        cursor: pointer; 
        font-size: 16px; 
        font-weight: bold;
        box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
        transition: background 0.3s;
      "
    >
      ${isSignIn ? 'sing In' : 'Proceed to Checkout'}
    </button>
  `

    // Add hover effect to the button
    const style = document.createElement('style')
    style.textContent = `
    #caramel-final-ok-btn:hover {
      background: #ffbf47;
    }
  `
    document.head.appendChild(style)

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    // Close the modal on button click
    modal
        .querySelector('#caramel-final-ok-btn')
        .addEventListener('click', () => {
            document.body.removeChild(overlay)
            if (isSignIn) {
                //show popup.html
                currentBrowser.runtime.sendMessage({ action: 'openPopup' })
            }
        })
}

async function getDomainRecord(domain) {
    let supportedDomains = []
    try {
        const response = await fetch(
            currentBrowser.runtime.getURL('supported.json'),
        )
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`)
        }
        const data = await response.json()
        supportedDomains = Array.isArray(data.supported) ? data.supported : data
    } catch (error) {
        console.error('Error loading supported.json:', error)
    }
    return supportedDomains.find(domainRecord =>
        domain.includes(domainRecord.domain),
    )
}

async function filterKeywords(keywords) {
    const specialChars = /[!@#$%^&*(),.?":{}|<>]/
    const lineBreaks = /[\n\r]/
    return Array.from(new Set(keywords)).filter(
        keyword =>
            keyword.length > 3 && // Length check
            !specialChars.test(keyword) && // No special characters
            !lineBreaks.test(keyword) && // No line breaks
            keyword.trim() !== '', // Not empty or whitespace
    )
}

function waitForDomUpdate(selector, { timeout = 5000 } = {}) {
    return new Promise((resolve, reject) => {
        let target = document.querySelector(selector)
        const root = target ? target : document.documentElement

        const observer = new MutationObserver(() => {
            target = document.querySelector(selector)
            if (target) {
                observer.disconnect()
                resolve()
            }
        })

        // Start observing
        observer.observe(root, {
            childList: true,
            characterData: true,
            subtree: true,
        })

        // Fallback: stop waiting after `timeout` ms
        setTimeout(() => {
            observer.disconnect()
            reject(
                `waitForDomUpdate: timed out after ${timeout}ms, no relevant changes.`,
            )
        }, timeout)
    })
}

window.addEventListener('message', event => {
    if (event.origin !== 'https://grabcaramel.com') return
    console.log('Caramel: Received message from', event.origin)
    if (event.data && event.data.token) {
        const user = {
            username: event.data.username || 'CaramelUser',
            image: event.data.image,
        }
        currentBrowser.storage.sync.set(
            { token: event.data.token, user },
            async () => {
                tryInitialize()
            },
        )
    }
})

currentBrowser.runtime.onMessage.addListener(
    async (request, sender, sendResponse) => {
        if (request.action === 'userLoggedIn') {
            const domain = window.location.hostname
            const domainRecord = await getDomainRecord(domain)
            await startApplyingCoupons(domainRecord)
            sendResponse({ success: true })
        }
    },
)
