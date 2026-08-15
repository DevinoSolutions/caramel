import { expect, test } from '@playwright/test'
import { seedVerifiedUser } from './support/seed-user'

// E-05 — the login SUCCESS path against a REAL better-auth session (every other
// auth spec here mocks /api/auth/** via page.route; this one does not). A
// verified user is seeded through the real signup API + a DB email_verified
// flip (see seed-user.ts), then we drive the real UI login and assert a
// genuinely authenticated landmark (the /profile page rendering the session's
// email). Gated on DATABASE_URL: the deployed-site e2e-push job has no seedable
// DB, so this group skips itself there and only runs in e2e-pr / local.
const SEEDABLE = !!process.env.DATABASE_URL
const REAL_LOGIN_EMAIL = 'e2e-login@caramel.dev'
const REAL_LOGIN_PASSWORD = 'E2ePass1234'
const seedBaseURL =
    process.env.PLAYWRIGHT_BASE_URL ||
    process.env.BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    'http://localhost:58000'

test.describe('Auth Flows — Login (real session)', () => {
    test.skip(!SEEDABLE, 'needs a seedable local/CI Postgres (DATABASE_URL)')

    test.beforeAll(async () => {
        if (!SEEDABLE) return
        await seedVerifiedUser({
            baseURL: seedBaseURL,
            email: REAL_LOGIN_EMAIL,
            password: REAL_LOGIN_PASSWORD,
            name: 'E2E Login User',
        })
    })

    test('real credentials sign in and reach an authenticated /profile', async ({
        page,
    }) => {
        await page.goto('/login')
        await page.getByPlaceholder('you@example.com').fill(REAL_LOGIN_EMAIL)
        await page
            .getByPlaceholder('Enter your password')
            .fill(REAL_LOGIN_PASSWORD)

        await page.getByRole('button', { name: 'Sign in', exact: true }).click()

        // On success the client sets a real session cookie then does
        // window.location.href = '/', so we land on the homepage.
        await expect(page).toHaveURL(/\/$/, { timeout: 15000 })

        // The session cookie now carries a real authenticated user: /profile is
        // a protected route that bounces unauthenticated visitors to /login, so
        // seeing the profile with the seeded email proves the session is real.
        await page.goto('/profile')
        // /profile is an account HOME now: its <h1> is the user's own name, not
        // the word "Profile". "Account details" is the stable landmark to wait
        // on — it renders straight from the session, so it does not depend on
        // the overview fetch resolving.
        await expect(
            page.getByRole('heading', { name: 'Account details' }),
        ).toBeVisible({ timeout: 10000 })
        await expect(page.getByText(REAL_LOGIN_EMAIL).first()).toBeVisible()
    })
})

test.describe('Auth Flows — Login', () => {
    test('login with invalid credentials shows error toast', async ({
        page,
    }) => {
        await page.goto('/login')
        await page.getByPlaceholder('you@example.com').fill('bad@example.com')
        await page.getByPlaceholder('Enter your password').fill('WrongPass1!')

        // Intercept the auth API to return an error without hitting real server
        await page.route('**/api/auth/sign-in/email', route =>
            route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: JSON.stringify({
                    message: 'Invalid credentials',
                    code: 'INVALID_CREDENTIALS',
                }),
            }),
        )

        await page.getByRole('button', { name: 'Sign in', exact: true }).click()

        // Sonner toast with error message
        await expect(
            page.getByText(
                /unable to sign in\. please check your email and password/i,
            ),
        ).toBeVisible({ timeout: 5000 })
    })

    test('login with unverified email redirects to /verify', async ({
        page,
    }) => {
        await page.goto('/login')
        await page
            .getByPlaceholder('you@example.com')
            .fill('unverified@example.com')
        await page.getByPlaceholder('Enter your password').fill('Test@12345')

        await page.route('**/api/auth/sign-in/email', route =>
            route.fulfill({
                status: 403,
                contentType: 'application/json',
                body: JSON.stringify({
                    message: 'Email not verified',
                    code: 'EMAIL_NOT_VERIFIED',
                }),
            }),
        )

        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await expect(page).toHaveURL(/\/verify/, { timeout: 10000 })
    })

    test('token_expired query param shows verification alert', async ({
        page,
    }) => {
        await page.goto('/login?error=token_expired')

        await expect(page.getByText(/verification link expired/i)).toBeVisible({
            timeout: 5000,
        })

        await expect(
            page.getByRole('button', { name: /request new link/i }),
        ).toBeVisible()
    })

    test('invalid_token query param shows verification alert', async ({
        page,
    }) => {
        await page.goto('/login?error=invalid_token')

        await expect(
            page.getByText(/verification link has expired or is invalid/i),
        ).toBeVisible({ timeout: 5000 })
    })

    test('verified=true query param shows success toast', async ({ page }) => {
        await page.goto('/login?verified=true')

        await expect(
            page.getByText(/email verified successfully/i),
        ).toBeVisible({ timeout: 5000 })
    })

    test('Request New Link button navigates to /verify', async ({ page }) => {
        await page.goto('/login?error=token_expired')

        await page
            .getByRole('button', { name: /request new link/i })
            .click({ timeout: 5000 })

        await expect(page).toHaveURL(/\/verify/)
    })
})

test.describe('Auth Flows — Signup', () => {
    // slow() = triple the 30s default. The waitForURL below already carries a
    // 30s budget of its own, so the DEFAULT test timeout expired first and
    // silently capped it — the redirect test died at exactly 30000ms on
    // 2026-08-10 (third signup flake that week; failOnFlakyTests turns one
    // slow CI boot into a red gate). The app is measured-fast (signup POST
    // 0.8s live); what's slow is a cold CI runner hydrating /signup and
    // loading /verify.
    test.slow()

    test('successful signup redirects to /verify?signup=success', async ({
        page,
    }) => {
        await page.goto('/signup')

        await page.getByPlaceholder('@nickname').fill('testuser')
        await page.getByPlaceholder('you@example.com').fill('new@example.com')
        await page.getByPlaceholder('Create a password').fill('Test@12345')
        await page.getByPlaceholder('Re-type your password').fill('Test@12345')

        // Intercept signup API to return success
        await page.route('**/api/auth/sign-up/email', route =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    user: { id: '1', email: 'new@example.com' },
                    token: 'fake-token',
                }),
            }),
        )

        // Click-until-the-POST-fires, because the budget-bump lineage below
        // never addressed the actual failure: on a cold deployed /signup the
        // click can land BEFORE React hydration attaches the submit handler,
        // so the click is silently swallowed, the request never leaves, and no
        // navigation timeout — 10s (flaky 2026-08-09), 30s + test.slow()
        // (flaky 2026-08-10 and twice on 2026-08-15) — can rescue a click
        // that did nothing. Each attempt re-clicks and gives the mocked POST
        // 3s to appear; a swallowed pre-hydration click just retries.
        await expect(async () => {
            const signupRequest = page.waitForRequest(
                '**/api/auth/sign-up/email',
                { timeout: 3000 },
            )
            await page
                .getByRole('button', { name: 'Create account', exact: true })
                .click()
            await signupRequest
        }).toPass({ timeout: 30000 })

        // `commit`, not `load`: the redirect goes through window.location.href
        // and the claim under test is "the app navigated to /verify" — the
        // full `load` event additionally waits for the deployed site's fonts
        // and analytics, which is the other half of the old flakiness.
        await page.waitForURL('**/verify?signup=success', {
            timeout: 30000,
            waitUntil: 'commit',
        })
    })

    test('signup with existing email shows error toast', async ({ page }) => {
        await page.goto('/signup')

        await page.getByPlaceholder('@nickname').fill('testuser')
        await page.getByPlaceholder('you@example.com').fill('taken@example.com')
        await page.getByPlaceholder('Create a password').fill('Test@12345')
        await page.getByPlaceholder('Re-type your password').fill('Test@12345')

        await page.route('**/api/auth/sign-up/email', route =>
            route.fulfill({
                status: 422,
                contentType: 'application/json',
                body: JSON.stringify({
                    message: 'User already exists',
                    code: 'USER_ALREADY_EXISTS',
                }),
            }),
        )

        // Same click-until-the-POST-fires shape as the redirect test above,
        // and for the same reason: a pre-hydration click is swallowed
        // silently, and the toast this test waits for can only appear after
        // the (mocked) 422 actually round-trips. Flaky at 5s on 2026-08-09,
        // and again at 15s on 2026-08-15 — the budget was never the problem.
        await expect(async () => {
            const signupRequest = page.waitForRequest(
                '**/api/auth/sign-up/email',
                { timeout: 3000 },
            )
            await page
                .getByRole('button', { name: 'Create account', exact: true })
                .click()
            await signupRequest
        }).toPass({ timeout: 30000 })

        // The response is mocked (fulfilled 422 above), so once the request
        // has fired this only measures the client rendering the toast.
        await expect(
            page.getByText(/unable to create your account/i),
        ).toBeVisible({ timeout: 15000 })
    })

    test('username too short shows validation error', async ({ page }) => {
        await page.goto('/signup')

        const nickname = page.getByPlaceholder('@nickname')
        await nickname.fill('ab')
        await nickname.blur()

        await page.getByPlaceholder('you@example.com').click()

        // Formik shows error after blur
        await expect(page.getByText(/at least 4 characters/i)).toBeVisible({
            timeout: 5000,
        })
    })
})

// The two tests below assert on text, and text that only exists after
// hydration is a race the runner wins or loses depending on load. This one
// failed CI twice in a day on commits that touched no app code at all, because
// /verify read its params with useSearchParams() and Next served the Suspense
// fallback — "Loading..." and nothing else — until the bundle arrived.
//
// The params are read on the server now, so the copy is in the HTML. Asserting
// that with JavaScript OFF is what keeps it that way: a future edit that moves
// the read back into the client cannot pass this, however fast the runner is.
test.describe('Auth Flows — before any JavaScript runs', () => {
    test.use({ javaScriptEnabled: false })

    test('the expired-link alert is in the HTML, button and all', async ({
        page,
    }) => {
        // This is the one that failed CI as a 5s timeout on a click: the alert
        // was built from window.location.search inside an effect, so the button
        // did not exist until hydration finished. A click cannot wait for that.
        await page.goto('/login?error=token_expired')

        await expect(page.getByText(/verification link expired/i)).toBeVisible()
        await expect(
            page.getByRole('button', { name: /request new link/i }),
        ).toBeVisible()
    })

    test('a login with no error params shows no alert at all', async ({
        page,
    }) => {
        // The alert is derived now, so "absent" has to be pinned as hard as
        // "present" — a rule that always fires is not a rule.
        await page.goto('/login')

        await expect(
            page.getByRole('button', { name: /request new link/i }),
        ).toHaveCount(0)
        await expect(page.getByText(/verification link expired/i)).toHaveCount(
            0,
        )
    })

    test('the signup message is server-rendered, not hydrated in', async ({
        page,
    }) => {
        await page.goto('/verify?signup=success')

        await expect(
            page.getByText(/we've sent a verification link/i),
        ).toBeVisible()
        await expect(page.getByText(/didn't get it/i)).toBeVisible()
    })

    test('so is the message for someone arriving without params', async ({
        page,
    }) => {
        await page.goto('/verify')

        await expect(
            page.getByText(/please verify your email address/i),
        ).toBeVisible()
    })
})

test.describe('Auth Flows — Verify Page', () => {
    test('verify page after signup shows correct messaging', async ({
        page,
    }) => {
        await page.goto('/verify?signup=success')

        await expect(
            page.getByText(/we've sent a verification link/i),
        ).toBeVisible()
        await expect(page.getByText(/didn't get it/i)).toBeVisible()
    })

    test('verify page without params shows default messaging', async ({
        page,
    }) => {
        await page.goto('/verify')

        await expect(
            page.getByText(/please verify your email address/i),
        ).toBeVisible()
        await expect(
            page.getByText(
                /enter your email below to receive a new verification link/i,
            ),
        ).toBeVisible()
    })

    test('verify page has email input and send button', async ({ page }) => {
        await page.goto('/verify')

        await expect(page.getByPlaceholder('you@example.com')).toBeVisible()
        await expect(
            page.getByRole('button', { name: /send verification email/i }),
        ).toBeVisible()
    })

    test('verify page has link back to login', async ({ page }) => {
        await page.goto('/verify')

        const signInLink = page.getByRole('link', { name: /sign in/i })
        await expect(signInLink).toBeVisible()
        await signInLink.click()
        await expect(page).toHaveURL(/\/login/)
    })

    test('send verification without email shows error toast', async ({
        page,
    }) => {
        await page.goto('/verify')

        await page
            .getByRole('button', { name: /send verification email/i })
            .click()

        await expect(page.getByText(/please enter your email/i)).toBeVisible({
            timeout: 5000,
        })
    })
})

test.describe('Auth Flows — Protected Routes', () => {
    test('profile page redirects unauthenticated user to /login', async ({
        page,
    }) => {
        // Intercept session check to return no session
        await page.route('**/api/auth/get-session', route =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(null),
            }),
        )

        await page.goto('/profile')
        await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
    })

    test('profile page shows user data when authenticated', async ({
        page,
    }) => {
        // Intercept session to return a mock user
        await page.route('**/api/auth/get-session', route =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    session: {
                        id: 'session-1',
                        userId: 'user-1',
                        expiresAt: new Date(
                            Date.now() + 7 * 24 * 60 * 60 * 1000,
                        ).toISOString(),
                    },
                    user: {
                        id: 'user-1',
                        name: 'carameluser',
                        email: 'test@example.com',
                        firstName: null,
                        lastName: null,
                    },
                }),
            }),
        )

        await page.goto('/profile')

        // The user's own name is the page's <h1> — the standalone "Profile"
        // heading is gone. Both assertions below render from the session
        // alone, which is the point: this test stubs only get-session, so
        // /api/account/overview genuinely fails here and the page must still
        // show real account content rather than collapsing to an error.
        await expect(
            page.getByRole('heading', { name: 'carameluser', level: 1 }),
        ).toBeVisible({ timeout: 5000 })
        await expect(
            page.getByRole('heading', { name: 'Account details' }),
        ).toBeVisible()
        await expect(page.getByText('test@example.com').first()).toBeVisible()
    })
})
