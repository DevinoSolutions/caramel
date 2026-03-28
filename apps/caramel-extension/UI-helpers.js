//UI HELPERS

/* -------------------------------------------------- UI prompt   */

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
        try {
            if (typeof log !== 'undefined')
                log('AUTO_INSERT_TRIGGERED_BY_UI', {
                    domain: domainRecord?.domain || location.hostname,
                    t: performance.now(),
                })
        } catch (e) {
            // ignore
        }
        startApplyingCoupons(domainRecord)
        document.body.removeChild(container)
    })

    document.body.appendChild(container)
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
        : "We couldn't find any working coupons for this page. You may already have the best price!"

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
      ${isSuccess ? '🎉 Savings Found! 🎉' : isSignIn ? 'Oups..' : 'No Savings This Time'}
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
