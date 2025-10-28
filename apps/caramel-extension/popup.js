/* global currentBrowser, fetchCoupons */

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
    if (loginToggle) loginToggle.addEventListener('click', handleLogin)

    const logout = document.getElementById('logoutBtn')
    if (logout)
        logout.addEventListener('click', () => {
            currentBrowser.storage.sync.remove(['token', 'user'], () =>
                renderUnsupportedSite(null),
            )
        })
}

/* ------------------------------------------------------------ */
/*  Login Handler                                               */
/* ------------------------------------------------------------ */
function handleLogin() {
    try {
        // Open login page in a new tab with extension parameter
        const baseUrl = 'https://grabcaramel.com' // Production URL
        const loginUrl = `${baseUrl}/login?extension=true`

        // Open login page in a new tab
        currentBrowser.tabs.create({ url: loginUrl })

        // Close the popup (it will reopen after auth completes)
        window.close()
    } catch (err) {
        console.error('[Login] Failed to open login page:', err)
    }
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

    /* logout */
    const logoutBtn = document.getElementById('logoutBtn')
    if (logoutBtn)
        logoutBtn.addEventListener('click', () => {
            currentBrowser.storage.sync.remove(['token', 'user'], handleLogin)
        })

    /* login toggle (guest) */
    const loginToggle = document.getElementById('loginToggleBtn')
    if (loginToggle) loginToggle.addEventListener('click', handleLogin)

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