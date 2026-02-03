/* global currentBrowser, fetchCoupons */

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
          href="https://grabcaramel.com/supported-stores"
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
/*  Login prompt                                                */
/* ------------------------------------------------------------ */
function renderSignInPrompt(backFn) {
    returnView = typeof backFn === 'function' ? backFn : null

    const container = document.getElementById('auth-container')

    container.innerHTML = `
    <div class="login-prompt fade-in-up">

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

      <div class="divider">
        <span>Or continue with</span>
      </div>

      <div class="oauth-buttons">
        <button type="button" id="googleLoginBtn" class="oauth-button google-button">
          <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" fill="#4285F4"/>
            <path d="M9.003 18c2.43 0 4.467-.806 5.956-2.18L12.05 13.56c-.806.54-1.836.86-3.047.86-2.344 0-4.328-1.584-5.036-3.711H.96v2.332C2.44 15.983 5.485 18 9.003 18z" fill="#34A853"/>
            <path d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.347 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9.003 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.464.891 11.426 0 9.003 0 5.485 0 2.44 2.017.96 4.958L3.967 7.29c.708-2.127 2.692-3.71 5.036-3.71z" fill="#EA4335"/>
          </svg>
          Sign in with Google
        </button>

        <button type="button" id="appleLoginBtn" class="oauth-button apple-button">
          <svg width="18" height="18" viewBox="0 0 18 22" xmlns="http://www.w3.org/2000/svg">
            <path d="M17.769 18.378c-.356.82-.528 1.186-0.988 1.912-.643.999-1.55 2.24-2.674 2.252-1.001.012-1.262-.654-2.627-.647-1.364.008-1.656.66-2.657.647-1.124-.012-1.982-1.116-2.625-2.115-1.797-2.794-1.985-6.073-0.877-7.818.79-1.244 2.041-1.975 3.202-1.975 1.191 0 1.939.655 2.923.655.954 0 1.534-.656 2.906-.656 1.037 0 2.146.566 2.933 1.543-2.577 1.412-2.158 5.089.484 6.202zm-5.084-14.378c.528-.663.912-1.597.766-2.539-.832.051-1.806.587-2.385 1.286-.517.625-.942 1.577-.778 2.489.919.037 1.862-.525 2.397-1.236z" fill="currentColor"/>
          </svg>
          Sign in with Apple
        </button>
      </div>

      <div id="resendVerificationContainer" style="display:none; text-align:center; margin-top:12px;">
        <a
          href="https://grabcaramel.com/verify"
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
          href="https://grabcaramel.com/signup"
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

    // Email/Password login
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
                'https://grabcaramel.com/api/extension/login',
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

    // OAuth buttons
    const googleLoginBtn = document.getElementById('googleLoginBtn')
    const appleLoginBtn = document.getElementById('appleLoginBtn')

    if (googleLoginBtn) {
        googleLoginBtn.addEventListener('click', () => handleOAuthLogin('google'))
    }

    if (appleLoginBtn) {
        appleLoginBtn.addEventListener('click', () => handleOAuthLogin('apple'))
    }
}

/* ------------------------------------------------------------ */
/*  OAuth Login Handler                                         */
/* ------------------------------------------------------------ */
function handleOAuthLogin(provider) {
    const authUrl = `https://grabcaramel.com/api/auth/${provider}?callbackURL=${encodeURIComponent('https://grabcaramel.com/extension-auth-callback')}`
    
    // Open OAuth in a popup window
    const width = 500
    const height = 600
    const left = (screen.width - width) / 2
    const top = (screen.height - height) / 2
    
    const popup = window.open(
        authUrl,
        'oauth-popup',
        `width=${width},height=${height},left=${left},top=${top}`
    )

    // Listen for the OAuth callback
    const messageListener = (event) => {
        if (event.origin !== 'https://grabcaramel.com') return
        
        if (event.data.type === 'oauth-success' && event.data.token) {
            const { token, user } = event.data
            currentBrowser.storage.sync.set({ token, user }, () => {
                window.removeEventListener('message', messageListener)
                if (popup) popup.close()
                initPopup()
            })
        }
    }

    window.addEventListener('message', messageListener)

    // Clean up if popup is closed
    const checkPopup = setInterval(() => {
        if (!popup || popup.closed) {
            clearInterval(checkPopup)
            window.removeEventListener('message', messageListener)
        }
    }, 1000)
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
            window.open('https://grabcaramel.com/profile', '_blank')
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
                ? '<p>No coupons found for this site</p>'
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
