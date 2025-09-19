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
          href="https://grabcaramel.com/supported-sites"
          class="supported-sites-btn"
          target="_blank"
          rel="noopener noreferrer"
        >
          View Supported Sites
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
        <span>or</span>
      </div>

      <button id="googleSignInBtn" class="google-signin-button">
        <svg width="18" height="18" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        Continue with Google
      </button>

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

    const loginForm = document.getElementById('loginForm')
    loginForm.addEventListener('submit', async e => {
        e.preventDefault()

        const errorBox = document.getElementById('loginErrorMessage')
        errorBox.style.display = 'none'
        errorBox.textContent = ''

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
                throw new Error(data.error || 'Login failed')
            }

            const { token, username, image } = await res.json()
            const user = { username, image }

            currentBrowser.storage.sync.set({ token, user }, () => initPopup())
        } catch (err) {
            errorBox.textContent = `Login failed: ${err.message}`
            errorBox.style.display = 'block'
        }
    })

    // Google Sign-in handler
    const googleSignInBtn = document.getElementById('googleSignInBtn')
    googleSignInBtn.addEventListener('click', async () => {
        const errorBox = document.getElementById('loginErrorMessage')
        errorBox.style.display = 'none'
        errorBox.textContent = ''

        try {
            // Open Google OAuth in a new tab
            const authUrl = 'https://grabcaramel.com/api/auth/signin/google'
            const authWindow = currentBrowser.windows.create({
                url: authUrl,
                type: 'popup',
                width: 500,
                height: 600,
            })

            // Listen for the auth window to close and check for success
            const checkClosed = setInterval(async () => {
                try {
                    const windows = await currentBrowser.windows.getAll()
                    const authWindowStillOpen = windows.some(w => w.id === authWindow.id)
                    
                    if (!authWindowStillOpen) {
                        clearInterval(checkClosed)
                        
                        // Check if user is now logged in by trying to get user info
                        const res = await fetch('https://grabcaramel.com/api/auth/session')
                        if (res.ok) {
                            const session = await res.json()
                            if (session.user) {
                                const { token, username, image } = session
                                const user = { username, image }
                                currentBrowser.storage.sync.set({ token, user }, () => initPopup())
                            }
                        }
                    }
                } catch (err) {
                    console.error('Error checking auth status:', err)
                }
            }, 1000)

        } catch (err) {
            errorBox.textContent = `Google sign-in failed: ${err.message}`
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
