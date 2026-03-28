/* global currentBrowser, fetchCoupons */

const CARAMEL_BASE_URL = 'http://localhost:58300'
const caramelUrl = path => new URL(path, `${CARAMEL_BASE_URL}/`).toString()

/* ------------------------------------------------------------ */
/*  Globals                                                     */
/* ------------------------------------------------------------ */
let returnView = null // callback for the “Back” button, set dynamically

/* ------------------------------------------------------------ */
/*  Bootstrap                                                   */
/* ------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', async () => {
    const loader = document.getElementById('loading-container')
    if (loader) setTimeout(() => (loader.style.display = 'none'), 400)

    await initPopup()
})

/* ------------------------------------------------------------ */
/*  Init                                                        */
/* ------------------------------------------------------------ */
async function initPopup() {
    const { url } = await getActiveTabDomainRecord()

    currentBrowser.storage.sync.get(['token', 'user'], async res => {
        const token = res.token || null
        const user = res.user || null

        if (url) {
            const domain = url.replace(/^(?:https?:\/\/)?(?:www\.)?/, '')
            const coupons = await fetchCoupons(domain, [])

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
    const avatar = user?.image?.length
        ? user.image
        : 'assets/default-profile.png'

    container.innerHTML = `
    <div class="no-coupons-view fade-in-up">
      <img src="${avatar}" class="no-coupons-avatar" alt="User avatar"/>

      <h3>No coupons are available for this site.</h3>
      <p>Click below to see which sites we support.</p>

      <div class="no-coupons-actions">
        <a
          href="${caramelUrl('supported-stores')}"
          class="supported-sites-btn"
          target="_blank"
          rel="noopener noreferrer"
        >
          View Supported Stores
        </a>

        ${
            user
                ? '<button id="logoutBtn" class="toggle-login-btn">Logout</button>'
                : '<button id="loginToggleBtn" class="toggle-login-btn">Login</button>'
        }

        <a
          href="https://github.com/DevinoSolutions/caramel"
          target="_blank"
          rel="noopener noreferrer"
          title="All extension code is 100% open-source."
        >
          <img src="assets/github.png" class="github-icon" alt="GitHub"/>
        </a>
      </div>
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
    loginForm.addEventListener('submit', async e => {
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

            const res = await fetch(
                caramelUrl('api/extension/login'),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password }),
                },
            )

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
      <img src="${avatar}" class="profile-image" alt="Profile"/>
      <div class="welcome-message">Welcome back, ${user.username}!</div>
      <div class="username">@${user.username}</div>

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

    document.getElementById('logoutBtn').addEventListener('click', () => {
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
          src="${user.image?.length ? user.image : 'assets/default-profile.png'}"
          class="coupons-profile-image"
          alt="avatar"
        />
        <span class="coupons-user-label">@${user.username}</span>
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

      <h3 class="coupon-header">Coupons for ${domain}</h3>

      <div id="couponList" class="coupon-list">
        ${
            coupons.length === 0
                ? '<p>No coupons available for this store right now.</p>'
                : coupons
                      .map(
                          c => `
            <div data-code="${c.code}" class="coupon-item">
              <div class="coupon-title">${c.title || 'Untitled Coupon'}</div>
              <div class="coupon-desc">${c.description || ''}</div>
              <div class="coupon-action">
                <button class="copyBtn">Copy "${c.code}"</button>
              </div>
            </div>`,
                      )
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

    /* copy-to-clipboard */
    container.querySelectorAll('.coupon-item').forEach(item => {
        item.addEventListener('click', e => {
            const code = e.currentTarget.getAttribute('data-code')
            navigator.clipboard
                .writeText(code)
                .then(() => showCopyToast(`Copied "${code}" to clipboard!`))
                .catch(() => {})
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
