import { expect, test } from '@playwright/test'

test.describe('Login Page', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/login')
        await expect(page.getByRole('button', { name: /login/i })).toBeVisible()
    })

    test('login form renders with all fields', async ({ page }) => {
        await expect(page.getByPlaceholder('Enter your email')).toBeVisible()
        await expect(page.getByPlaceholder('Enter your password')).toBeVisible()
        await expect(page.getByRole('button', { name: /login/i })).toBeVisible()
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
        const signupLink = page.getByRole('link', { name: /sign up/i })
        await expect(signupLink).toBeVisible()
        await signupLink.click()
        await expect(page).toHaveURL(/\/signup/)
    })

    test('shows validation on empty submit', async ({ page }) => {
        await page.getByRole('button', { name: /login/i }).click()
        // HTML5 form validation should prevent submission
        const emailInput = page.getByPlaceholder('Enter your email')
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
            page.getByRole('button', { name: 'Sign Up', exact: true }),
        ).toBeVisible()
    })

    test('signup form renders with all fields', async ({ page }) => {
        await expect(page.getByPlaceholder('@nickname')).toBeVisible()
        await expect(page.getByPlaceholder('Enter your email')).toBeVisible()
        await expect(page.getByPlaceholder('Create a password')).toBeVisible()
        await expect(page.getByPlaceholder('Re-type Password')).toBeVisible()
        await expect(
            page.getByRole('button', { name: 'Sign Up', exact: true }),
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
        const loginLink = page.getByRole('link', { name: /login/i })
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
        await page.getByPlaceholder('Enter your email').click()
        await page.keyboard.press('Tab')

        await expect(page.getByPlaceholder('Create a password')).toBeFocused()
        await expect(
            page.getByText(/uppercase|special character|number/i).first(),
        ).toBeVisible({ timeout: 5000 })
    })

    test('shows validation errors for weak password', async ({ page }) => {
        await page.getByPlaceholder('@nickname').fill('testuser')
        await page.getByPlaceholder('Enter your email').fill('test@example.com')
        await page.getByPlaceholder('Create a password').fill('weak')
        await page.getByPlaceholder('Re-type Password').fill('weak')

        await page
            .getByRole('button', { name: 'Sign Up', exact: true })
            .click({ force: true })

        // Should show password validation errors
        const errorText = page.getByText(
            /uppercase|special character|at least|password/i,
        )
        await expect(errorText.first()).toBeVisible({ timeout: 5000 })
    })

    test('shows mismatch error when passwords differ', async ({ page }) => {
        // Click password field to trigger PasswordChecker visibility
        const passwordInput = page.getByPlaceholder('Create a password')
        await passwordInput.click()
        await passwordInput.fill('Test@12345')

        const confirmInput = page.getByPlaceholder('Re-type Password')
        await confirmInput.click()
        await confirmInput.fill('Different@123')

        // PasswordChecker shows "Passwords must match" when passwords differ
        const mismatch = page.getByText('Passwords must match')
        await expect(mismatch).toBeVisible({ timeout: 5000 })
    })
})
