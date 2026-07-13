//UI HELPERS

/* -------------------------------------------------- UI prompt   */

// Called from shared-utils.js: content_scripts share one global scope per
// manifest.json (no ES modules), so per-file analysis can't see this call.
// oxlint-disable-next-line no-unused-vars
async function insertCaramelPrompt(domainRecord) {
    if (document.getElementById('caramel-small-prompt')) return
    const container = document.createElement('div')
    container.id = 'caramel-small-prompt'
    container.setAttribute('role', 'button')
    container.setAttribute('tabindex', '0')
    container.setAttribute(
        'aria-label',
        'Try Caramel Coupons — auto-apply the best code at checkout',
    )
    const logoUrl = await currentBrowser.runtime.getURL('assets/logo-light.png')
    container.innerHTML = `
    <button id="caramel-close-btn" aria-label="Dismiss">×</button>
    <div class="caramel-prompt-row">
      <img class="caramel-prompt-logo" src="${logoUrl}" alt=""/>
      <div class="caramel-prompt-copy">
        <div class="caramel-prompt-label">Try Caramel Coupons</div>
        <small>Auto-apply the best code at checkout</small>
      </div>
      <svg class="caramel-prompt-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
`

    const _dismiss = () => {
        if (container.parentNode) document.body.removeChild(container)
    }
    const _activate = () => {
        try {
            if (typeof log !== 'undefined')
                log('AUTO_INSERT_TRIGGERED_BY_UI', {
                    domain: domainRecord?.domain || location.hostname,
                    t: performance.now(),
                })
        } catch {
            // ignore
        }
        startApplyingCoupons(domainRecord).catch(err => {
            // A throw mid-flow must never leave the overlay trapping the page.
            console.error('Caramel: apply flow error', err)
            hideTestingModal()
        })
        _dismiss()
    }

    container.addEventListener('click', event => {
        // Close button → just dismiss; anywhere else on the prompt → start.
        if (event.target.id === 'caramel-close-btn') {
            _dismiss()
            return
        }
        _activate()
    })
    // Keyboard parity (the prompt is role="button"): Enter/Space on the prompt
    // itself starts the flow. Guard target===container so Enter on the × button
    // only closes.
    container.addEventListener('keydown', event => {
        if (
            event.target === container &&
            (event.key === 'Enter' ||
                event.key === ' ' ||
                event.key === 'Spacebar')
        ) {
            event.preventDefault()
            _activate()
        }
    })

    document.body.appendChild(container)
}

// Called from shared-utils.js (see insertCaramelPrompt above for why
// per-file analysis misses this).
// oxlint-disable-next-line no-unused-vars
async function showTestingModal(title = '', noLoading = false) {
    const overlay = document.createElement('div')
    overlay.id = 'caramel-testing-overlay'

    const modal = document.createElement('div')
    modal.id = 'caramel-testing-modal'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-label', 'Applying coupons')

    const logoUrl = currentBrowser.runtime.getURL('assets/logo-light.png')

    const loadingHTML = `<p id="caramel-test-status">Checking this store for codes…</p>
    <div id="caramel-progress-container">
      <div id="caramel-progress-bar"></div>
    </div>`

    modal.innerHTML = `
    <button id="caramel-testing-close" title="Stop">×</button>
    <div class="caramel-modal-header">
      <img class="caramel-modal-logo" src="${logoUrl}" alt="Caramel Logo" />
      <h2>${title || 'Applying Coupons...'}</h2>
    </div>
   ${noLoading ? '' : loadingHTML}`

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    // Let the user bail out — never trap them behind the overlay.
    const _close = modal.querySelector('#caramel-testing-close')
    if (_close)
        _close.addEventListener('click', () => {
            _caramelCancelled = true
            hideTestingModal()
        })
    // Esc cancels (keyboard parity with the × button).
    const onKey = e => {
        if (e.key === 'Escape') {
            _caramelCancelled = true
            hideTestingModal()
        }
    }
    overlay.__caramelOnKey = onKey
    document.addEventListener('keydown', onKey)
    // Focus the dialog itself (a11y) — not the × button, which would flash a
    // focus ring on open.
    try {
        modal.tabIndex = -1
        modal.focus()
    } catch {
        /* focus is best-effort */
    }
}

/**
 * Updates the "Testing Coupons" modal:
 *  - Changes the status text
 *  - Updates the progress bar width based on current vs total
 */
// Called from shared-utils.js (see insertCaramelPrompt above for why
// per-file analysis misses this).
// oxlint-disable-next-line no-unused-vars
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
        if (overlay.__caramelOnKey)
            document.removeEventListener('keydown', overlay.__caramelOnKey)
        document.body.removeChild(overlay)
    }
}

/* Robust, accurate copy of an exact coupon code. Tries the async clipboard
 * API first (works on the user-gesture from the Copy click); falls back to a
 * hidden textarea + execCommand for pages that block the async API. */
async function caramelCopyText(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch {
        // page may block the async clipboard API — fall through to execCommand
    }
    try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.top = '-1000px'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
    } catch {
        return false
    }
}

// Called from shared-utils.js (see insertCaramelPrompt above for why
// per-file analysis misses this).
// oxlint-disable-next-line no-unused-vars
async function showFinalModal(
    savingsAmount,
    code,
    message,
    isSignIn = false,
    couponList = [],
) {
    hideTestingModal()
    const overlay = document.createElement('div')
    overlay.id = 'caramel-final-overlay'

    const modal = document.createElement('div')
    modal.className = 'caramel-final-modal'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-label', 'Caramel coupons')

    // Three terminal states the user might be in:
    //   savedMoney   = we computed a real price drop ($X off)
    //   appliedCode  = we applied a code but couldn't measure savings
    //                  (site has no priceContainer in config — the cart
    //                  may show the discount inline; we just can't read
    //                  the number reliably). Still a win for the user.
    //   noLuck       = nothing applied (or signed-out / network error)
    const savedMoney = savingsAmount > 0
    const appliedCode = !savedMoney && !!code
    const isSuccess = savedMoney || appliedCode

    // Manual fallback: auto-apply found nothing but we still have codes. Many
    // codes are valid yet the store's checkout ignores the extension's
    // synthetic click (Shopify one-page checkout requires event.isTrusted),
    // so a hand-pasted code still works — offer the user a copy list.
    const manualCodes = (
        !isSuccess && Array.isArray(couponList) ? couponList : []
    )
        .filter(c => c && c.code)
        .slice(0, 8)
    const hasManual = manualCodes.length > 0

    const esc = s =>
        String(s == null ? '' : s).replace(
            /[&<>"']/g,
            ch =>
                ({
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#39;',
                })[ch],
        )

    // Build the secondary message based on which state we landed in.
    let finalMessage
    if (savedMoney) {
        finalMessage = `We found a coupon that saves you $${savingsAmount.toFixed(2)}!`
    } else if (appliedCode) {
        // Prefer an explicit caller message (threshold hints, non-USD
        // formatting) over the generic applied line.
        finalMessage =
            message ||
            `Code ${esc(code)} is applied to your cart — review the discount before you check out.`
    } else if (hasManual) {
        // Prefer an explicit caller message (e.g. "couldn't find the promo box")
        // so we tell the user the REAL reason instead of a generic "didn't stick".
        finalMessage =
            message ||
            "Auto-apply didn't stick this time. Copy a code and paste it in the store's promo box."
    } else if (isSignIn) {
        finalMessage =
            message || 'Sign in to unlock member-only coupons for this store.'
    } else {
        finalMessage =
            message || "Looks like you're already getting the best deal."
    }

    // Caramel brand/logo
    const brandColor = '#ea6925'
    const logoUrl = currentBrowser.runtime.getURL('assets/logo.png') // Adjust if needed

    const heading = savedMoney
        ? 'Savings Found'
        : appliedCode
          ? '✓ Coupon Applied'
          : isSignIn
            ? 'Sign in to continue'
            : hasManual
              ? 'Grab a code'
              : 'Heads up'

    const manualBlock = hasManual
        ? `
        <div class="caramel-manual-list">
          ${manualCodes
              .map(
                  c => `
            <div class="caramel-manual-row">
              <div class="caramel-manual-info">
                <div class="caramel-manual-code">${esc(c.code)}</div>
                ${c.title ? `<div class="caramel-manual-title">${esc(c.title)}</div>` : ''}
              </div>
              <button class="caramel-manual-copy" data-code="${esc(c.code)}">Copy</button>
            </div>`,
              )
              .join('')}
        </div>`
        : ''

    modal.innerHTML = `
    <div class="caramel-final-logo">
      <img src="${logoUrl}" alt="Caramel Logo" />
    </div>
    <h2>${heading}</h2>
    <p class="caramel-final-msg">${finalMessage}</p>
    ${manualBlock}
    ${
        isSuccess
            ? `
            <p class="caramel-final-code">
              Code: <span>${esc(code)}</span>
            </p>
            ${
                savedMoney
                    ? `<p class="caramel-final-savings">You saved $${savingsAmount.toFixed(2)}!</p>`
                    : `<p class="caramel-final-hint">Discount visible in your cart.</p>`
            }
          `
            : ''
    }
    <button id="caramel-final-ok-btn">
      ${isSignIn ? 'Sign In' : hasManual ? 'Done' : 'Proceed to Checkout'}
    </button>
  `

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    // Single close path — also detaches the Esc listener so we never leak a
    // document keydown handler onto the store's page after the modal is gone.
    const closeFinal = () => {
        if (overlay.__caramelOnKey)
            document.removeEventListener('keydown', overlay.__caramelOnKey)
        if (overlay.parentNode) document.body.removeChild(overlay)
    }

    // Wire manual-copy buttons — copies the EXACT code shown (data-code).
    modal.querySelectorAll('.caramel-manual-copy').forEach(btn => {
        btn.addEventListener('click', async ev => {
            ev.stopPropagation()
            const cc = btn.getAttribute('data-code')
            const ok = await caramelCopyText(cc)
            const prev = btn.textContent
            btn.textContent = ok ? 'Copied!' : 'Press Ctrl+C'
            btn.style.background = ok ? '#1f9d55' : brandColor
            setTimeout(() => {
                btn.textContent = prev
                btn.style.background = brandColor
            }, 1600)
        })
    })

    // Close on the primary button; Esc closes too (keyboard). Focus the button
    // on open so keyboard/screen-reader users land on the main action.
    const okBtn = modal.querySelector('#caramel-final-ok-btn')
    if (okBtn)
        okBtn.addEventListener('click', () => {
            closeFinal()
            if (isSignIn) {
                //show popup.html
                currentBrowser.runtime.sendMessage({ action: 'openPopup' })
            }
        })
    const onKey = e => {
        if (e.key === 'Escape') closeFinal()
    }
    overlay.__caramelOnKey = onKey
    document.addEventListener('keydown', onKey)
    // Move focus INTO the dialog (a11y) without lighting up a button's focus
    // ring on open — focus the modal container, not the primary button. A
    // keyboard user then Tabs to the button and gets the proper focus-visible
    // ring; a mouse user sees a clean button.
    try {
        modal.tabIndex = -1
        modal.focus()
    } catch {
        /* focus is best-effort */
    }
}
