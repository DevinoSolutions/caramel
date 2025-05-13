// popup.js

document.addEventListener('DOMContentLoaded', async () => {
    // Remove the loading overlay after a short delay
    const loadingContainer = document.getElementById('loading-container')
    if (loadingContainer) {
        setTimeout(() => {
            loadingContainer.style.display = 'none'
        }, 400)
    }

    // 1) Main init
    await initPopup()
})

// ========================================================
//  Main logic entry — checks the current domain via background
// ========================================================
async function initPopup() {
    const { url } = await getActiveTabDomainRecord()
    // Grab the user’s auth info from storage
    currentBrowser.storage.sync.get(['token', 'user'], async result => {
        const token = result.token
        const user = result.user
        if (url) {
            const domainString = url.replace(/^(?:https?:\/\/)?(?:www\.)?/, '')
            console.log('Domain string:', domainString)
            const coupons = await fetchCoupons(domainString, [])
            console.log('Coupons:', coupons)
            if (coupons?.length) {
                await proceedPopulateCoupons(coupons, user, domainString)
                return
            }
        }
        if (token) {
            renderProfileCard(user)
        } else {
            renderSignInPrompt()
        }
    })
}

// ========================================================
//  Ask background for the domain record of the active tab
// ========================================================
function getActiveTabDomainRecord() {
    return new Promise(resolve => {
        currentBrowser.runtime.sendMessage(
            { action: 'getActiveTabDomainRecord' },
            response => {
                resolve(response)
            },
        )
    })
}

// ========================================================
//  Old logic unchanged below...
// ========================================================
function renderSignInPrompt() {
    const authContainer = document.getElementById('auth-container')
    authContainer.innerHTML = `
      <div class="login-prompt fade-in-up">
        <p>In order to start using our coupons, please sign in!</p>
        <form id="loginForm" class="login-form">
          <div id="loginErrorMessage" class="error-message" style="display: none;"></div>
          <div>
            <label>Email</label>
            <input type="email" id="email" required />
          </div>
          <div>
            <label>Password</label>
            <input type="password" id="password" required />
          </div>
          <button type="submit" class="login-button">Login</button>
        </form>
        <p class="mt-6">Don't have an account?
          <a href="https://grabcaramel.com/signup" target="_blank" rel="noopener noreferrer">Sign Up</a>
        </p>
      </div>
    `

    // Hide the settings icon when not logged in
    const settingsIcon = document.getElementById('settingsIcon')
    if (settingsIcon) {
        settingsIcon.style.display = 'none'
    }

    const loginForm = document.getElementById('loginForm')
    loginForm.addEventListener('submit', async e => {
        e.preventDefault()

        const errorMessageElem = document.getElementById('loginErrorMessage')
        errorMessageElem.style.display = 'none'
        errorMessageElem.textContent = ''

        const email = document.getElementById('email').value.trim()
        const password = document.getElementById('password').value

        try {
            // Call your Next.js endpoint at /extension/login
            const response = await fetch(
                'https://grabcaramel.com/api/extension/login',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password }),
                },
            )

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}))
                throw new Error(errData.error || 'Login failed')
            }

            const { token, username, image } = await response.json()
            const user = { username, image }

            // Store token/user
            currentBrowser.storage.sync.set({ token, user }, () => {
                // Re-init the popup so it can show the "profile card" or "checkout UI"
                initPopup()
            })
        } catch (err) {
            console.error('Login error:', err)
            errorMessageElem.textContent = `Login failed: ${err.message}`
            errorMessageElem.style.display = 'block'
        }
    })
}

function renderProfileCard(user) {
    const authContainer = document.getElementById('auth-container')
    const imageUrl =
        user.image && user.image.length
            ? user.image
            : 'assets/default-profile.png'

    authContainer.innerHTML = `
    <div class="profile-card fade-in-up">
      <img src="${imageUrl}" alt="Profile" class="profile-image" />
      <div class="welcome-message">Welcome back, ${user.username}!</div>
      <div class="username">@${user.username}</div>
      <div class="profile-actions">
        <button id="logoutButton" class="logout-button">Logout</button>
      </div>
    </div>
  `

    // Show the settings icon in the header
    const settingsIcon = document.getElementById('settingsIcon')
    if (settingsIcon) {
        settingsIcon.style.display = 'block'
        settingsIcon.onclick = () => {
            window.open('https://grabcaramel.com/profile', '_blank')
        }
    }

    document.getElementById('logoutButton').addEventListener('click', () => {
        currentBrowser.storage.sync.remove(['token', 'user'], () => {
            // Re-init so it shows the sign-in prompt again
            initPopup()
        })
    })
}

// ========================================================
//  NEW 1: Render login prompt specifically for "checkout" flows
//         (Same as normal login, but includes a "Back" button.)
// ========================================================

// ========================================================
//  NEW 2: Show the actual coupon list for the recognized domain
// ========================================================
async function renderCheckoutCoupons(domainRecord, user) {
    // 1) Fetch coupons for this domain
    const coupons = await getCoupons(domainRecord, true)

    await proceedPopulateCoupons(coupons, user, domainRecord.domain)
}

async function proceedPopulateCoupons(coupons, user, url) {
    const authContainer = document.getElementById('auth-container')
    // 2) Determine what to display in the top "header" area
    let headerLeftHtml = ''
    let headerRightButtonHtml = ''

    if (user) {
        // Logged-in scenario: show user profile image + username
        const imageUrl =
            user.image && user.image.length
                ? user.image
                : 'assets/default-profile.png'

        headerLeftHtml = `
            <img src="${imageUrl}" alt="Profile" class="coupons-profile-image" />
            <span class="coupons-user-label">@${user.username}</span>
        `
        // Logged-in user sees a "Logout" button
        headerRightButtonHtml = `<button id="logoutButton" class="coupons-logout-button">Logout</button>`
    } else {
        // Guest scenario
        headerLeftHtml = `
            <img src="assets/default-profile.png" alt="Profile" class="coupons-profile-image" />
            <span class="coupons-user-label">Guest</span>
        `
        headerRightButtonHtml = `<button id="loginButton" class="coupons-logout-button">Login</button>`
    }

    authContainer.innerHTML = `
        <div class="coupons-profile-card fade-in-up">
            <!-- Minimal "profile" row on top (like a header) -->
            <div class="coupons-profile-row">
                <div class="coupons-profile-info">
                    ${headerLeftHtml}
                </div>
                ${headerRightButtonHtml}
            </div>

            <h3 class="coupon-header">Coupons for ${url}</h3>
            <div id="couponList" class="coupon-list">
                ${
                    coupons.length === 0
                        ? `<p>No coupons found for this site</p>`
                        : coupons
                              .map(
                                  c => `
                                <div data-code="${c.code}" class="coupon-item">
                                    <div class="coupon-title">${c.title || 'Untitled Coupon'}</div>
                                    <div class="coupon-desc">${c.description || ''}</div>
                                    <div class="coupon-action">
                                        <button 
                                            class="copyBtn" 
                                        >
                                            Copy "${c.code}"
                                        </button>
                                    </div>
                                </div>
                            `,
                              )
                              .join('')
                }
            </div>
        </div>
        <!-- Toast container (for showing copy notifications) -->
        <div id="toastContainer" class="copy-toast-container"></div>
    `

    // 4) Wire up the "Logout" or "Login" button
    if (user) {
        const logoutButton = document.getElementById('logoutButton')
        if (logoutButton) {
            logoutButton.addEventListener('click', () => {
                currentBrowser.storage.sync.remove(['token', 'user'], () => {
                    // Now user is logged out -> show sign-in prompt for checkout
                    renderSignInPrompt()
                })
            })
        }
    } else {
        const loginBtn = document.getElementById('loginButton')
        if (loginBtn) {
            loginBtn.addEventListener('click', () => {
                renderSignInPrompt()
            })
        }
    }

    // 5) Copy button logic + show a toast when successful
    const copyButtons = authContainer.querySelectorAll('.coupon-item')
    copyButtons.forEach(btn => {
        btn.addEventListener('click', e => {
            const code = e.currentTarget.getAttribute('data-code')
            navigator.clipboard
                .writeText(code)
                .then(() => {
                    console.log(`Copied coupon code: ${code}`)
                    showCopyToast(`Copied "${code}" to clipboard!`)
                })
                .catch(err => console.error('Failed to copy code', err))
        })
    })
}

/**
 * Creates and displays a brief toast message indicating a successful copy.
 */
function showCopyToast(message) {
    const toastContainer = document.getElementById('toastContainer')
    if (!toastContainer) return

    // Create the toast element
    const toast = document.createElement('div')
    toast.className = 'copy-toast'
    toast.innerText = message

    // Add it to the container
    toastContainer.appendChild(toast)

    // Remove it after animation completes (or set a timer)
    setTimeout(() => {
        toast.classList.add('fade-out')
        toast.addEventListener('animationend', () => {
            toast.remove()
        })
    }, 2000)
}
