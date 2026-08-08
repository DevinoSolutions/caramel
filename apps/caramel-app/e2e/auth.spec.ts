import { expect, test } from '@playwright/test'

/* Copy updated with the 2026-08-09 auth redesign. The assertions are the same
 * ones as before — fields render, providers are offered, the cross-links
 * navigate, validation fires — retargeted at the new wording, plus coverage for
 * what the redesign added (the password reveal toggle and the forgot-password
 * entry point, which did not exist at all). */

test.describe('Login Page', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/login')
        await expect(
            page.getByRole('button', { name: 'Sign in', exact: true }),
        ).toBeVisible()
    })

    test('login form renders with all fields', async ({ page }) => {
        await expect(page.getByPlaceholder('you@example.com')).toBeVisible()
        await expect(page.getByPlaceholder('Enter your password')).toBeVisible()
        await expect(
            page.getByRole('button', { name: 'Sign in', exact: true }),
        ).toBeVisible()
    })

    test('page exposes exactly one h1 for the form', async ({ page }) => {
        // Every auth page used to open at h2 with no h1 in the document.
        const headings = page.getByRole('heading', { level: 1 })
        await expect(headings).toHaveCount(1)
        await expect(headings).toHaveText(/welcome back/i)
    })

    test('social login buttons are present', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /sign in with google/i }),
        ).toBeVisible()
        await expect(
            page.getByRole('button', { name: /sign in with apple/i }),
        ).toBeVisible()
    })

    test('has link to signup page', async ({ page }) => {
        const signupLink = page.getByRole('link', { name: /create one free/i })
        await expect(signupLink).toBeVisible()
        await signupLink.click()
        await expect(page).toHaveURL(/\/signup/)
    })

    test('offers a password reset route', async ({ page }) => {
        /* There was no way to recover an account before this shipped: no link,
         * no route, and no sendResetPassword on the server. */
        const forgot = page.getByRole('link', { name: /forgot password/i })
        await expect(forgot).toBeVisible()
        await forgot.click()
        // Generous: in `next dev` this is the route's first compile.
        await expect(page).toHaveURL(/\/forgot-password/, { timeout: 30000 })
        await expect(
            page.getByRole('button', { name: /send reset link/i }),
        ).toBeVisible()
    })

    test('password can be revealed and re-hidden', async ({ page }) => {
        const password = page.getByPlaceholder('Enter your password')
        await password.fill('hunter2')
        await expect(password).toHaveAttribute('type', 'password')

        const toggle = page.getByRole('button', { name: /show password/i })
        await toggle.click()
        await expect(password).toHaveAttribute('type', 'text')

        await page.getByRole('button', { name: /hide password/i }).click()
        await expect(password).toHaveAttribute('type', 'password')
    })

    test('shows validation on empty submit', async ({ page }) => {
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        // HTML5 form validation should prevent submission
        const emailInput = page.getByPlaceholder('you@example.com')
        const isInvalid = await emailInput.evaluate(
            (el: HTMLInputElement) => !el.validity.valid,
        )
        expect(isInvalid).toBe(true)
    })
})

test.describe('Signup Page', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/signup')
        await expect(
            page.getByRole('button', { name: 'Create account', exact: true }),
        ).toBeVisible()
    })

    test('signup form renders with all fields', async ({ page }) => {
        await expect(page.getByPlaceholder('@nickname')).toBeVisible()
        await expect(page.getByPlaceholder('you@example.com')).toBeVisible()
        await expect(page.getByPlaceholder('Create a password')).toBeVisible()
        await expect(
            page.getByPlaceholder('Re-type your password'),
        ).toBeVisible()
        await expect(
            page.getByRole('button', { name: 'Create account', exact: true }),
        ).toBeVisible()
    })

    test('social signup buttons are present', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /sign up with google/i }),
        ).toBeVisible()
        await expect(
            page.getByRole('button', { name: /sign up with apple/i }),
        ).toBeVisible()
    })

    test('has link to login page', async ({ page }) => {
        const loginLink = page.getByRole('link', { name: /sign in/i })
        await expect(loginLink).toBeVisible()
        await loginLink.click()
        await expect(page).toHaveURL(/\/login/)
    })

    test('password strength checker appears on focus', async ({ page }) => {
        const passwordInput = page.getByPlaceholder('Create a password')
        const checker = page
            .getByText(/uppercase|special character|number/i)
            .first()

        /* The focus is retried, not just the assertion.
         *
         * This panel is React state, so it can only appear once React's
         * listener is attached. A focus that lands before hydration goes
         * nowhere and is never replayed, so waiting longer on the assertion
         * alone is waiting for an element that will never render from that
         * interaction. It failed CI on 2026-08-06 on a commit that touched no
         * app code at all.
         *
         * The blur matters: refocusing an already-focused input fires no
         * second focus event, so without it every retry after the first is a
         * no-op and the retry loop is decoration.
         */
        await expect(async () => {
            await passwordInput.blur()
            await passwordInput.focus()
            await expect(checker).toBeVisible({ timeout: 2000 })
        }).toPass({ timeout: 20000 })
    })

    test('password requirements reachable by keyboard alone', async ({
        page,
    }) => {
        /* The regression guard for the onClick→onFocus change. A shopper who
         * tabs to the password field, or whose password manager fills it,
         * issues no click — under onClick they were told the password was
         * wrong with the reasons still hidden. Tab from the field above
         * rather than calling focus(), so this fails if the panel ever goes
         * back to needing a pointer. */
        await page.getByPlaceholder('you@example.com').click()
        await page.keyboard.press('Tab')

        await expect(page.getByPlaceholder('Create a password')).toBeFocused()
        await expect(
            page.getByText(/uppercase|special character|number/i).first(),
        ).toBeVisible({ timeout: 5000 })
    })

    test('states the real minimum password length', async ({ page }) => {
        /* The checklist used to hard-code its own policy and ticked "minimum
         * length reached" at 5 while the schema demanded more. Both now read
         * from lib/passwordRules, so this pins the number a shopper is shown. */
        await page.getByPlaceholder('Create a password').focus()
        await expect(
            page.getByText(/at least 8 characters/i).first(),
        ).toBeVisible({ timeout: 5000 })
    })

    test('shows validation errors for weak password', async ({ page }) => {
        await page.getByPlaceholder('@nickname').fill('testuser')
        await page.getByPlaceholder('you@example.com').fill('test@example.com')
        await page.getByPlaceholder('Create a password').fill('weak')
        await page.getByPlaceholder('Re-type your password').fill('weak')

        await page
            .getByRole('button', { name: 'Create account', exact: true })
            .click({ force: true })

        // Should show password validation errors
        const errorText = page.getByText(
            /uppercase|special character|at least|password/i,
        )
        await expect(errorText.first()).toBeVisible({ timeout: 5000 })
    })

    test('never shows a raw regex as a validation message', async ({
        page,
    }) => {
        /* yup prints the constraint itself when a rule carries no message, so
         * the old schema told shoppers "password must match the following:
         * /[A-Z]/". */
        await page.getByPlaceholder('@nickname').fill('testuser')
        await page.getByPlaceholder('you@example.com').fill('test@example.com')
        await page.getByPlaceholder('Create a password').fill('lowercase1!')
        await page.getByPlaceholder('Re-type your password').fill('lowercase1!')
        await page
            .getByRole('button', { name: 'Create account', exact: true })
            .click({ force: true })

        await expect(page.getByText(/must match the following/i)).toHaveCount(0)
        await expect(page.locator('body')).not.toContainText('/[A-Z]/')
    })

    test('shows mismatch error when passwords differ', async ({ page }) => {
        // Click password field to trigger PasswordChecker visibility
        const passwordInput = page.getByPlaceholder('Create a password')
        await passwordInput.click()
        await passwordInput.fill('Test@12345')

        const confirmInput = page.getByPlaceholder('Re-type your password')
        await confirmInput.click()
        await confirmInput.fill('Different@123')

        // PasswordChecker shows "Passwords must match" when passwords differ
        const mismatch = page.getByText('Passwords must match')
        await expect(mismatch).toBeVisible({ timeout: 5000 })
    })
})

test.describe('Auth shell', () => {
    /* The (auth) group renders its own full-screen shell. When a route is
     * missing from providers.tsx's pagesLayoutless list it ALSO gets the
     * marketing Layout, so the page ships two headers, two theme toggles and a
     * site footer wrapped around the form. /forgot-password and
     * /reset-password did exactly that when first added. */
    for (const route of [
        '/login',
        '/signup',
        '/verify',
        '/forgot-password',
        '/reset-password',
    ]) {
        test(`${route} renders without the marketing header and footer`, async ({
            page,
        }) => {
            await page.goto(route)
            await expect(page.getByRole('heading', { level: 1 })).toBeVisible({
                timeout: 30000,
            })

            await expect(page.getByRole('banner')).toHaveCount(0)
            await expect(page.getByRole('contentinfo')).toHaveCount(0)
            // One theme toggle, not the auth shell's plus the site header's.
            await expect(
                page.getByRole('button', { name: /light|dark/i }),
            ).toHaveCount(1)
        })
    }
})

test.describe('Password reset', () => {
    test('reset page refuses a request with no token', async ({ page }) => {
        await page.goto('/reset-password')
        await expect(
            page.getByRole('heading', { level: 1, name: /expired/i }),
        ).toBeVisible()
        await expect(
            page.getByRole('link', { name: /request a new link/i }),
        ).toBeVisible()
    })

    test('reset pages are not indexable', async ({ page }) => {
        /* The reset URL carries a single-use token as a query parameter, so an
         * indexed copy would publish it. */
        await page.goto('/reset-password?token=example')
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
            'content',
            /noindex/,
        )
    })

    test('forgot-password does not reveal whether an account exists', async ({
        page,
    }) => {
        await page.goto('/forgot-password')
        await page
            .getByPlaceholder('you@example.com')
            .fill('definitely-not-a-user@example.com')
        await page.getByRole('button', { name: /send reset link/i }).click()

        // Same confirmation regardless of whether the address is registered:
        // branching here would make this form an account-enumeration oracle.
        await expect(
            page.getByRole('heading', { level: 1, name: /check your inbox/i }),
        ).toBeVisible({ timeout: 15000 })
    })
})
