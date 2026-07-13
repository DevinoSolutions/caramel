/* global currentBrowser, fetchCoupons */

// Dev/prod base URL via the shared _isDevInstall() (defined in
// caramel-base.js, loaded before this script — formerly shared-utils.js,
// split by F-008). Packed Web Store builds have a manifest update_url →
// prod; unpacked dev installs → the DEV deployment. No `management` perm.
const CARAMEL_BASE_URL =
    typeof _isDevInstall === 'function' && _isDevInstall()
        ? 'https://dev.grabcaramel.com'
        : 'https://grabcaramel.com'
const caramelUrl = path => new URL(path, `${CARAMEL_BASE_URL}/`).toString()

// Escape coupon/API data before interpolating into innerHTML. Codes, titles and
// messages come from the API; without this a code containing a quote/angle
// bracket would break its `data-code` attribute (corrupting the copied value)
// or leak stray markup into the layout.
const escHtml = s =>
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

/* ------------------------------------------------------------ */
/*  Globals                                                     */
/* ------------------------------------------------------------ */
let returnView = null // callback for the “Back” button, set dynamically

/* ------------------------------------------------------------ */
/*  Bootstrap                                                   */
/* ------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', async () => {
    const loader = document.getElementById('loading-container')
    // Anti-flicker floor, not a fetch-duration ceiling: a near-instant
    // response still shows the spinner for a beat, but initPopup() (below)
    // now actually awaits the fetch+render — so on a slow/degraded
    // connection the spinner correctly outlives 400ms instead of leaving a
    // blank auth-container gap while the real request is still in flight.
    const minDisplay = new Promise(resolve => setTimeout(resolve, 400))

    await Promise.all([initPopup(), minDisplay])

    if (loader) loader.style.display = 'none'
})

/* ------------------------------------------------------------ */
/*  Init                                                        */
/* ------------------------------------------------------------ */
async function initPopup() {
    // The service worker can reply undefined on a cold start / error; never let
    // destructuring throw and leave the user staring at a blank popup.
    let url = null
    try {
        const resp = await getActiveTabDomainRecord()
        url = resp?.url ?? null
    } catch {
        url = null
    }

    // Wrapped in a Promise so initPopup() itself doesn't resolve until the
    // chosen render state has actually been painted (storage.sync.get is a
    // chrome-callback API, not natively awaitable) — the DOMContentLoaded
    // bootstrap above depends on that to know when the loader can come down.
    await new Promise(resolve => {
        currentBrowser.storage.sync.get(['token', 'user'], async res => {
            const token = res?.token || null
            const user = res?.user || null

            // Wrap the whole render: a fetch failure (backend down / offline) must
            // show an honest error state with a retry, NEVER leave the popup blank.
            try {
                if (url) {
                    const domain = url.replace(
                        /^(?:https?:\/\/)?(?:www\.)?/,
                        '',
                    )
                    let coupons = []
                    try {
                        coupons = await fetchCoupons(domain, '')
                    } catch {
                        renderLoadError()
                        return
                    }

                    if (coupons?.length) {
                        await renderCouponsView(coupons, user, domain)
                    } else {
                        renderUnsupportedSite(user)
                    }
                    return
                }

                // no active tab info
                if (token) renderProfileCard(user)
                else renderUnsupportedSite(null)
            } catch {
                renderLoadError()
            } finally {
                resolve()
            }
        })
    })
}

/* Network/backend failure state — keeps the popup from rendering blank when the
   coupon API is unreachable. Offers a retry that re-runs the whole init. */
function renderLoadError() {
    const container = document.getElementById('auth-container')
    if (!container) return
    container.innerHTML = `
    <div class="no-coupons-view fade-in-up">
      <div class="empty-illu" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ea6925" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h.01"/>
          <path d="M8.5 16.4a5 5 0 0 1 7 0"/>
          <path d="M5 12.9a10 10 0 0 1 14 0"/>
          <path d="M2 9.5a16 16 0 0 1 20 0"/>
          <path d="M2 2l20 20"/>
        </svg>
      </div>
      <h3>Couldn't load coupons</h3>
      <p>Check your connection and try again.</p>
      <div class="no-coupons-actions">
        <button id="retryBtn" class="supported-sites-btn" type="button">Try again</button>
      </div>
    </div>`
    const retry = document.getElementById('retryBtn')
    if (retry)
        retry.addEventListener('click', () => {
            container.innerHTML = ''
            initPopup()
        })
}

/* background helper */
async function getActiveTabDomainRecord() {
    const resp = await new Promise(resolve => {
        currentBrowser.runtime.sendMessage(
            { action: 'getActiveTabDomainRecord' },
            reply => resolve(reply), // will be undefined on error
        )
    })

    return resp
}

/* ------------------------------------------------------------ */
/*  Unsupported-site view                                       */
/* ------------------------------------------------------------ */
function renderUnsupportedSite(user) {
    const container = document.getElementById('auth-container')

    container.innerHTML = `
    <div class="no-coupons-view fade-in-up">
      <div class="empty-illu" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
          stroke="#ea6925" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/>
          <circle cx="7.5" cy="7.5" r="1.3" fill="#ea6925" stroke="none"/>
        </svg>
      </div>

      <h3>No coupons for this site yet</h3>
      <p>We're adding new stores all the time — see the ones we support.</p>

      <div class="no-coupons-actions">
        <a
          href="${caramelUrl('supported-stores')}"
          class="supported-sites-btn"
          target="_blank"
          rel="noopener noreferrer"
        >View Supported Stores</a>

        ${
            user
                ? '<button id="logoutBtn" class="toggle-login-btn">Log out</button>'
                : '<button id="loginToggleBtn" class="toggle-login-btn">Log in</button>'
        }
      </div>

      <a
        class="oss-link"
        href="https://github.com/DevinoSolutions/caramel"
        target="_blank"
        rel="noopener noreferrer"
        title="All extension code is 100% open-source."
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.03.08-2.13 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.93.08 2.13.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
        </svg>
        <span>Open source</span>
      </a>
    </div>
  `

    /* wiring */
    const loginToggle = document.getElementById('loginToggleBtn')
    if (loginToggle)
        loginToggle.addEventListener('click', () =>
            renderSignInPrompt(() => renderUnsupportedSite(user)),
        )

    const logout = document.getElementById('logoutBtn')
    if (logout)
        logout.addEventListener('click', () => {
            currentBrowser.storage.sync.remove(['token', 'user'], () =>
                renderUnsupportedSite(null),
            )
        })
}

/* ------------------------------------------------------------ */
/*  OAuth Social Sign-In Handler                                */
/* ------------------------------------------------------------ */
async function handleSocialSignIn(provider) {
    const errorBox = document.getElementById('loginErrorMessage')
    const googleBtn = document.getElementById('googleSignInBtn')
    const appleBtn = document.getElementById('appleSignInBtn')
    const button = provider === 'google' ? googleBtn : appleBtn

    // Disable button and show loading state
    if (button) {
        button.disabled = true
        const span = button.querySelector('span')
        if (span) {
            span.textContent = 'Redirecting...'
        }
    }

    if (errorBox) {
        errorBox.style.display = 'none'
        errorBox.textContent = ''
    }

    try {
        const baseURL = CARAMEL_BASE_URL

        // Check if identity API is available
        const identity =
            currentBrowser.identity || currentBrowser.chrome?.identity
        if (!identity || !identity.launchWebAuthFlow) {
            throw new Error(
                'OAuth not supported in this browser. Please use email/password login.',
            )
        }

        // Get the extension's redirect URL
        // This will be something like: https://[extension-id].chromiumapp.org/
        const redirectUri = identity.getRedirectURL()

        // First, get the OAuth authorization URL from our backend
        // This endpoint will fetch the actual OAuth provider URL from better-auth
        const authorizeUrl = `${baseURL}/api/extension/oauth/authorize?provider=${provider}&redirect_uri=${encodeURIComponent(redirectUri)}`

        const authorizeResponse = await fetch(authorizeUrl, {
            method: 'GET',
        })

        if (!authorizeResponse.ok) {
            const errorData = await authorizeResponse.json().catch(() => ({}))
            const errorMessage =
                errorData.error ||
                `HTTP ${authorizeResponse.status}: Failed to get OAuth authorization URL`
            console.error('Authorize endpoint error:', {
                status: authorizeResponse.status,
                statusText: authorizeResponse.statusText,
                error: errorData,
            })
            throw new Error(errorMessage)
        }

        const responseData = await authorizeResponse.json().catch(() => ({}))

        if (!responseData.authorizationUrl) {
            console.error(
                'Invalid response from authorize endpoint:',
                responseData,
            )
            throw new Error(
                `Failed to get OAuth authorization URL. Response: ${JSON.stringify(responseData)}`,
            )
        }

        const { authorizationUrl } = responseData

        // Launch OAuth flow using chrome.identity with the actual OAuth provider URL
        // This opens a popup window for the user to authenticate
        // The OAuth provider will redirect to our extension's redirect URL with the code
        const finalCallbackUrl = await identity.launchWebAuthFlow({
            url: authorizationUrl,
            interactive: true,
        })

        // User closed the OAuth window without finishing → undefined callback.
        // Surface a clear "cancelled" message, not a cryptic `new URL(undefined)`.
        if (!finalCallbackUrl) throw new Error('Sign-in was cancelled.')

        // Extract code and state from the callback URL
        // Google redirects to the extension's redirect URI: https://[extension-id].chromiumapp.org/?code=...&state=...
        // chrome.identity captures this URL, and we extract the code from it
        const callbackUrlObj = new URL(finalCallbackUrl)
        const code = callbackUrlObj.searchParams.get('code')
        const receivedState = callbackUrlObj.searchParams.get('state')
        const error = callbackUrlObj.searchParams.get('error')

        if (error) {
            throw new Error(
                `OAuth error: ${error}. Please try again or use email/password login.`,
            )
        }

        if (!code) {
            // If no code, check if better-auth redirected us to a success page
            // In that case, we might need to extract the code from a different parameter
            // or make a follow-up request
            throw new Error(
                'Failed to receive authorization code. Please try again.',
            )
        }

        // Send the code to our OAuth endpoint
        // Include the redirect URI so the backend can exchange the code for tokens
        const oauthResponse = await fetch(`${baseURL}/api/extension/oauth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider,
                code,
                state: receivedState, // Send state back to the backend
                redirectUri, // Include redirect URI for token exchange
            }),
        })

        if (!oauthResponse.ok) {
            const errorData = await oauthResponse.json().catch(() => ({}))
            const errorMessage =
                errorData.error ||
                `OAuth authentication failed. Please try again.`
            throw new Error(errorMessage)
        }

        const { token, username, image } = await oauthResponse.json()
        const user = { username, image }

        // Store token and user data using Promise wrapper to ensure completion
        await new Promise((resolve, reject) => {
            currentBrowser.storage.sync.set({ token, user }, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message))
                    return
                }
                resolve()
            })
        })

        // Small delay to ensure storage is fully persisted
        await new Promise(resolve => setTimeout(resolve, 100))

        // Only call initPopup if popup is still open
        if (document.visibilityState === 'visible') {
            initPopup()
        }
    } catch (err) {
        console.error('OAuth error:', err)

        // Show error message
        if (errorBox) {
            errorBox.textContent = `OAuth sign-in failed: ${err.message}`
            errorBox.style.display = 'block'
        }

        // Re-enable button
        if (button) {
            button.disabled = false
            const span = button.querySelector('span')
            if (span) {
                span.textContent =
                    provider === 'google'
                        ? 'Sign in with Google'
                        : 'Sign in with Apple'
            }
        }
    }
}

/* ------------------------------------------------------------ */
/*  Login prompt                                                */
/* ------------------------------------------------------------ */
function renderSignInPrompt(backFn) {
    returnView = typeof backFn === 'function' ? backFn : null

    const container = document.getElementById('auth-container')

    container.innerHTML = `
    <div class="login-prompt fade-in-up">

      <div class="oauth-buttons">
        <button type="button" id="googleSignInBtn" class="oauth-button" disabled>
          <svg class="oauth-icon" width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/>
            <path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.348 6.175 0 7.55 0 9s.348 2.825.957 4.039l3.007-2.332z"/>
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z"/>
          </svg>
          <span>Sign in with Google</span>
        </button>
        <button type="button" id="appleSignInBtn" class="oauth-button" disabled>
          <svg class="oauth-icon" width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path fill="#000000" d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
          </svg>
          <span>Sign in with Apple</span>
        </button>
      </div>

      <div class="oauth-divider">
        <span>or</span>
      </div>

      <form id="loginForm" class="login-form">
        <div id="loginErrorMessage" class="error-message" style="display:none;"></div>

        <div>
          <label>Email</label>
          <input type="email" id="email" required/>
        </div>

        <div>
          <label>Password</label>
          <input type="password" id="password" required/>
        </div>

        <button type="submit" class="login-button">Login</button>
      </form>

      <div id="resendVerificationContainer" style="display:none; text-align:center; margin-top:12px;">
        <a
          href="${caramelUrl('verify')}"
          target="_blank"
          rel="noopener noreferrer"
          class="resend-verification-btn"
          style="display:inline-block; text-decoration:none;"
        >
          Verify your email
        </a>
      </div>

      <p class="mt-6">
        Don't have an account?
        <a
          href="${caramelUrl('signup')}"
          target="_blank"
          rel="noopener noreferrer"
        >Sign Up</a>
      </p>

      ${
          returnView
              ? '<button id="backBtn" class="back-btn" type="button">← Back</button>'
              : ''
      }
    </div>
  `

    const settingsIcon = document.getElementById('settingsIcon')
    if (settingsIcon) settingsIcon.style.display = 'none'

    const backBtn = document.getElementById('backBtn')
    if (backBtn && returnView) backBtn.addEventListener('click', returnView)

    const resendVerificationContainer = document.getElementById(
        'resendVerificationContainer',
    )

    // OAuth button handlers
    const googleSignInBtn = document.getElementById('googleSignInBtn')
    const appleSignInBtn = document.getElementById('appleSignInBtn')

    if (googleSignInBtn) {
        googleSignInBtn.disabled = false
        googleSignInBtn.addEventListener('click', () =>
            handleSocialSignIn('google'),
        )
    }

    if (appleSignInBtn) {
        appleSignInBtn.disabled = false
        appleSignInBtn.addEventListener('click', () =>
            handleSocialSignIn('apple'),
        )
    }

    const loginForm = document.getElementById('loginForm')
    loginForm?.addEventListener('submit', async e => {
        e.preventDefault()

        const errorBox = document.getElementById('loginErrorMessage')
        errorBox.style.display = 'none'
        errorBox.textContent = ''
        errorBox.style.color = ''
        if (resendVerificationContainer)
            resendVerificationContainer.style.display = 'none'

        try {
            const email = document.getElementById('email').value.trim()
            const password = document.getElementById('password').value

            const res = await fetch(caramelUrl('api/extension/login'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            })

            if (!res.ok) {
                const data = await res.json().catch(() => ({}))
                const error = data.error || 'Login failed'

                // Check if error is about email verification
                if (
                    error.toLowerCase().includes('verify') ||
                    error.toLowerCase().includes('verification') ||
                    error.toLowerCase().includes('not verified')
                ) {
                    if (resendVerificationContainer) {
                        resendVerificationContainer.style.display = 'block'
                    }
                }

                throw new Error(error)
            }

            const { token, username, image } = await res.json()
            const user = { username, image }

            currentBrowser.storage.sync.set({ token, user }, () => initPopup())
        } catch (err) {
            errorBox.textContent = `Login failed: ${err.message}`
            errorBox.style.display = 'block'
        }
    })
}

/* ------------------------------------------------------------ */
/*  Profile card                                                */
/* ------------------------------------------------------------ */
function renderProfileCard(user) {
    const container = document.getElementById('auth-container')
    const avatar = user.image?.length
        ? user.image
        : 'assets/default-profile.png'

    container.innerHTML = `
    <div class="profile-card fade-in-up">
      <img src="${escHtml(avatar)}" class="profile-image" alt="Profile"/>
      <div class="welcome-message">Welcome back, ${escHtml(user.username)}!</div>
      <div class="username">@${escHtml(user.username)}</div>

      <div class="profile-actions">
        <button id="logoutBtn" class="logout-button">Logout</button>
      </div>
    </div>
  `

    const settingsIcon = document.getElementById('settingsIcon')
    if (settingsIcon) {
        settingsIcon.style.display = 'block'
        settingsIcon.onclick = () =>
            window.open(caramelUrl('profile'), '_blank')
    }

    const logoutBtn = document.getElementById('logoutBtn')
    if (logoutBtn)
        logoutBtn.addEventListener('click', () => {
            currentBrowser.storage.sync.remove(['token', 'user'], initPopup)
        })
}

/* ------------------------------------------------------------ */
/*  Coupons view                                                */
/* ------------------------------------------------------------ */
function renderCouponsView(coupons, user, domain) {
    const container = document.getElementById('auth-container')

    const headerLeft = user
        ? `
        <img
          src="${escHtml(user.image?.length ? user.image : 'assets/default-profile.png')}"
          class="coupons-profile-image"
          alt="avatar"
        />
        <span class="coupons-user-label">@${escHtml(user.username)}</span>
      `
        : `
        <img src="assets/default-profile.png" class="coupons-profile-image" alt="avatar"/>
        <span class="coupons-user-label">Guest</span>
      `

    const headerRight = user
        ? '<button id="logoutBtn" class="coupons-logout-button">Logout</button>'
        : '<button id="loginToggleBtn" class="coupons-logout-button">Login</button>'

    container.innerHTML = `
    <div class="coupons-profile-card fade-in-up">
      <div class="coupons-profile-row">
        <div class="coupons-profile-info">${headerLeft}</div>
        ${headerRight}
      </div>

      <h3 class="coupon-header">Coupons for ${escHtml(domain)}</h3>

      <div id="couponList" class="coupon-list">
        ${
            coupons.length === 0
                ? '<p>No coupons available for this store right now.</p>'
                : coupons
                      .map(c => {
                          // Sourced from window.CaramelCoupons
                          // (coupon-constants.generated.js, loaded before
                          // this file — F-006) instead of a hard-coded
                          // literal, so this can't re-drift from the app's
                          // src/lib/coupons.ts.
                          const restrictedSet = new Set(
                              window.CaramelCoupons.RESTRICTED_STATUSES,
                          )
                          const isRestricted = restrictedSet.has(c.status)
                          const isDead =
                              c.status === 'invalid' || c.status === 'expired'
                          let warning = ''
                          if (isRestricted) {
                              const baseMsg =
                                  c.status === 'category_restricted'
                                      ? 'Limited to specific categories'
                                      : c.status === 'seller_specific'
                                        ? 'Only for items from a specific seller'
                                        : c.status === 'valid_with_warning'
                                          ? 'May have restrictions'
                                          : 'Limited to specific items'
                              const cartHint = c.cartCategory
                                  ? ` — your cart looks like <b>${escHtml(c.cartCategory)}</b>${c.cartCategorySecondary ? ` / ${escHtml(c.cartCategorySecondary)}` : ''}`
                                  : ''
                              const verifierMsg = c.verificationMessage
                                  ? `<div class="coupon-restriction-detail">${escHtml(c.verificationMessage)}</div>`
                                  : ''
                              warning = `
              <div class="coupon-restriction" title="${escHtml(c.verificationMessage || baseMsg)}">
                <span class="coupon-restriction-icon">⚠</span>
                <span class="coupon-restriction-text">${baseMsg}${cartHint}</span>
                ${verifierMsg}
              </div>`
                          }
                          // Verification badge: green=verified, amber=restricted,
                          // grey=not yet verified (grace), red=known not valid.
                          // Labels + which status maps to which tier come from
                          // window.CaramelCoupons.STATUS_META
                          // (coupon-constants.generated.js, F-006); this hex
                          // palette is the popup-local half (the app's
                          // coupon-card.tsx keeps its own Tailwind equivalent —
                          // the 4-tier axis can't drift the way the 9-status
                          // axis did).
                          const TIER_HEX = {
                              green: ['#15803d', '#dcfce7'],
                              amber: ['#b45309', '#fef3c7'],
                              grey: ['#4b5563', '#f3f4f6'],
                              red: ['#b91c1c', '#fee2e2'],
                          }
                          const meta =
                              window.CaramelCoupons.STATUS_META[c.status]
                          const bd = meta
                              ? [meta.label, ...TIER_HEX[meta.tier]]
                              : undefined
                          const badge = bd
                              ? `<span class="coupon-badge" title="${escHtml(c.verificationMessage || '')}" style="color:${bd[1]};background:${bd[2]}">${bd[0]}</span>`
                              : ''
                          return `
            <div data-code="${escHtml(c.code)}" role="button" tabindex="0" aria-label="${escHtml((c.title || 'Coupon') + ' — copy code ' + c.code)}" class="coupon-item${isRestricted ? ' coupon-item-restricted' : ''}${isDead ? ' coupon-item-dead' : ''}">
              <div class="coupon-head">
                <div class="coupon-title">${escHtml(c.title || 'Untitled Coupon')}</div>
                ${badge}
              </div>
              ${c.description ? `<div class="coupon-desc">${escHtml(c.description)}</div>` : ''}
              ${warning}
              <div class="coupon-code-row">
                <span class="coupon-code">${escHtml(c.code)}</span>
                <span class="coupon-copy">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="9" y="9" width="11" height="11" rx="2.5" stroke="currentColor" stroke-width="2"/>
                    <path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                  Copy
                </span>
              </div>
            </div>`
                      })
                      .join('')
        }
      </div>
    </div>

    <div id="toastContainer" class="copy-toast-container"></div>
  `

    /* save callback for login back-button */
    const selfCallback = () => renderCouponsView(coupons, user, domain)

    /* logout */
    const logoutBtn = document.getElementById('logoutBtn')
    if (logoutBtn)
        logoutBtn.addEventListener('click', () => {
            currentBrowser.storage.sync.remove(['token', 'user'], () =>
                renderSignInPrompt(selfCallback),
            )
        })

    /* login toggle (guest) */
    const loginToggle = document.getElementById('loginToggleBtn')
    if (loginToggle)
        loginToggle.addEventListener('click', () =>
            renderSignInPrompt(selfCallback),
        )

    /* copy-to-clipboard (mouse + keyboard). Robust copy: async clipboard API
       with an execCommand fallback (shared caramelCopyText from UI-helpers.js).
       The bare navigator.clipboard path silently did nothing when the API was
       blocked — now the user always gets either the code on the clipboard or
       honest feedback instead of a dead click. */
    const copyFromItem = async item => {
        const code = item.getAttribute('data-code')
        const ok = await caramelCopyText(code)
        showCopyToast(
            ok
                ? `Copied "${code}" to clipboard!`
                : `Couldn't copy — code is ${code}`,
        )
    }
    container.querySelectorAll('.coupon-item').forEach(item => {
        item.addEventListener('click', () => copyFromItem(item))
        // Keyboard users / screen readers: the card is role="button", so
        // Enter and Space must activate it like a real button.
        item.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault()
                copyFromItem(item)
            }
        })
    })
}

/* ------------------------------------------------------------ */
/*  Toast helper                                                */
/* ------------------------------------------------------------ */
function showCopyToast(message) {
    const host = document.getElementById('toastContainer')
    if (!host) return

    const toast = document.createElement('div')
    toast.className = 'copy-toast'
    toast.textContent = message
    host.appendChild(toast)

    setTimeout(() => {
        toast.classList.add('fade-out')
        toast.addEventListener('animationend', () => toast.remove())
    }, 2000)
}
