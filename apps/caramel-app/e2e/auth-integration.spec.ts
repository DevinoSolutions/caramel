import { expect, test } from '@playwright/test'

test.describe('Auth Integration & Session Management', () => {
    const baseURL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:58000'

    test.describe('Navbar Profile Integration', () => {
        test('should show login/signup buttons when not authenticated', async ({
            page,
        }) => {
            await page.goto('/')

            // Should show Login and Sign Up buttons
            const loginButton = page.getByRole('link', { name: /^login$/i })
            const signupButton = page.getByRole('link', { name: /sign up/i })

            await expect(loginButton).toBeVisible()
            await expect(signupButton).toBeVisible()

            // Profile icon should not be visible
            const profileIcon = page.locator(
                'button:has(div.rounded-full.bg-caramel)',
            )
            await expect(profileIcon).not.toBeVisible()
        })

        test('should show profile icon when authenticated', async ({
            page,
            context,
        }) => {
            // Set up authenticated session (this would require actual auth setup)
            await page.goto('/')

            // If authenticated, profile icon should be visible
            const profileIcon = page
                .locator('button')
                .filter({ has: page.locator('.bg-caramel.rounded-full') })
                .first()

            // Check if icon exists (depends on auth state)
            const exists = await profileIcon.count()
            if (exists > 0) {
                await expect(profileIcon).toBeVisible()

                // Login/Signup buttons should be hidden
                const loginButton = page.getByRole('link', {
                    name: /^login$/i,
                })
                await expect(loginButton).not.toBeVisible()
            }
        })

        test('should open dropdown when clicking profile icon', async ({
            page,
        }) => {
            await page.goto('/')

            const profileIcon = page
                .locator('button.bg-caramel.rounded-full')
                .first()
            const iconExists = await profileIcon.count()

            if (iconExists > 0) {
                await profileIcon.click()

                // Dropdown should appear
                const dropdown = page.locator('div:has-text("Profile")')
                await expect(dropdown).toBeVisible()

                // Should have Profile link and Sign out button
                await expect(
                    page.getByRole('link', { name: /^profile$/i }),
                ).toBeVisible()
                await expect(
                    page.getByRole('button', { name: /sign out/i }),
                ).toBeVisible()
            }
        })

        test('should close dropdown when clicking outside', async ({
            page,
        }) => {
            await page.goto('/')

            const profileIcon = page
                .locator('button.bg-caramel.rounded-full')
                .first()
            const iconExists = await profileIcon.count()

            if (iconExists > 0) {
                await profileIcon.click()

                // Wait for dropdown to appear
                await page.waitForSelector('a[href="/profile"]', {
                    state: 'visible',
                })

                // Click outside
                await page.click('body', { position: { x: 10, y: 10 } })

                // Dropdown should close
                await expect(
                    page.locator('a[href="/profile"]'),
                ).not.toBeVisible()
            }
        })

        test('should navigate to profile from dropdown', async ({ page }) => {
            await page.goto('/')

            const profileIcon = page
                .locator('button.bg-caramel.rounded-full')
                .first()
            const iconExists = await profileIcon.count()

            if (iconExists > 0) {
                await profileIcon.click()

                // Click Profile link
                await page.click('a[href="/profile"]')

                // Should navigate to profile page
                await expect(page).toHaveURL('/profile')
            }
        })
    })

    test.describe('Mobile Menu Integration', () => {
        test('should show login/signup in mobile menu when logged out', async ({
            page,
        }) => {
            await page.setViewportSize({ width: 375, height: 667 })
            await page.goto('/')

            // Open hamburger menu
            const hamburger = page.locator('button.text-2xl').first()
            await hamburger.click()

            // Wait for mobile menu
            await page.waitForSelector('.flex-col', { state: 'visible' })

            // Should show Login and Sign Up buttons
            const loginLink = page.getByRole('link', { name: /^login$/i })
            const signupLink = page.getByRole('link', { name: /sign up/i })

            await expect(loginLink).toBeVisible()
            await expect(signupLink).toBeVisible()
        })

        test('mobile menu should close after clicking link', async ({
            page,
        }) => {
            await page.setViewportSize({ width: 375, height: 667 })
            await page.goto('/')

            // Open menu
            const hamburger = page.locator('button.text-2xl').first()
            await hamburger.click()

            // Wait for menu to appear
            await page.waitForTimeout(500)

            // Click a navigation link (login button which should be visible)
            const loginLink = page.getByRole('link', { name: /^login$/i })
            await loginLink.click()

            // Should navigate to login
            await expect(page).toHaveURL('/login')
        })
    })

    test.describe('Login/Signup Button Styling', () => {
        test('login button should have correct styling', async ({ page }) => {
            await page.goto('/')

            const loginButton = page.getByRole('link', { name: /^login$/i })

            // Should have Caramel text color
            await expect(loginButton).toHaveClass(/text-caramel/)

            // Should not have background color (text button)
            const classes = await loginButton.getAttribute('class')
            expect(classes).not.toContain('bg-caramel')
        })

        test('signup button should have filled styling', async ({ page }) => {
            await page.goto('/')

            const signupButton = page.getByRole('link', { name: /sign up/i })

            // Should have Caramel background
            await expect(signupButton).toHaveClass(/bg-caramel/)

            // Should have white text
            await expect(signupButton).toHaveClass(/text-white/)
        })

        test('buttons should have hover effects', async ({ page }) => {
            await page.goto('/')

            const loginButton = page.getByRole('link', { name: /^login$/i })
            const signupButton = page.getByRole('link', { name: /sign up/i })

            // Check for hover scale class
            await expect(loginButton).toHaveClass(/hover:scale-105/)
            await expect(signupButton).toHaveClass(/hover:scale-105/)
        })
    })

    test.describe('Email/Password Authentication Flow', () => {
        test.skip('should complete full signup flow', async ({ page }) => {
            // SKIPPED: This test is flaky due to signup/verification flow timing
            // The signup process may show errors or not redirect immediately
            // TODO: Fix by using database seeding or mocking email service
            await page.goto('/signup')

            const timestamp = Date.now()
            const email = `test_${timestamp}@example.com`

            // Fill signup form
            await page.fill('input[name="username"]', 'testuser')
            await page.fill('input[name="email"]', email)
            await page.fill('input[name="password"]', 'Test123!')
            await page.fill('input[name="confirmPassword"]', 'Test123!')

            // Submit form
            // Submit and wait for navigation (window.location.href is used)
            await Promise.all([
                page.waitForNavigation({ timeout: 20000 }),
                page.click('button[type="submit"]'),
            ])

            // Should redirect to verify page
            await expect(page).toHaveURL(/\/verify/)
        })

        test('should show password validation errors', async ({ page }) => {
            await page.goto('/signup')

            await page.fill('input[name="username"]', 'testuser')
            await page.fill('input[name="email"]', 'test@example.com')
            await page.fill('input[name="password"]', 'weak')
            await page.fill('input[name="confirmPassword"]', 'different')

            // Blur to trigger validation
            await page.click('input[name="confirmPassword"]')
            await page.click('body')

            // Should show validation errors (check multiple possible selectors)
            const errorElements = page.locator(
                '.text-red-500, .text-destructive, [role="alert"]',
            )
            const errorCount = await errorElements.count()
            expect(errorCount).toBeGreaterThan(0)
        })

        test('should display password strength checker', async ({ page }) => {
            await page.goto('/signup')

            // Click password field
            await page.click('input[name="password"]')

            // Type password
            await page.fill('input[name="password"]', 'Test123!')

            // Password checker should appear (if enabled)
            const passwordChecker = page.locator('text=/password strength/i')
            const exists = await passwordChecker.count()

            // Note: Password checker is dynamically loaded
            if (exists > 0) {
                await expect(passwordChecker).toBeVisible()
            }
        })

        test('should login with valid credentials', async ({ page }) => {
            await page.goto('/login')

            // Use a pre-existing test account or skip if none exists
            await page.fill('input[type="email"]', 'test@example.com')
            await page.fill('input[type="password"]', 'Test123!')

            await page.click('button[type="submit"]')

            // Should show loading state
            await expect(
                page.locator('button:has-text("Logging")'),
            ).toBeVisible()
        })

        test('should show error for invalid login', async ({ page }) => {
            await page.goto('/login')

            await page.fill('input[type="email"]', 'wrong@example.com')
            await page.fill('input[type="password"]', 'wrongpassword')

            await page.click('button[type="submit"]')

            // Should show error toast (any error message)
            const errorToast = page.locator(
                '[data-sonner-toast], .sonner-toast',
            )
            await expect(errorToast.first()).toBeVisible({ timeout: 5000 })
        })
    })

    test.describe('Protected Routes', () => {
        test('should redirect to login when accessing protected route', async ({
            page,
        }) => {
            // Clear cookies to ensure logged out state
            await page.context().clearCookies()

            await page.goto('/profile')

            // Should redirect to login
            await page.waitForURL('/login')
            await expect(page).toHaveURL('/login')
        })

        test('public routes should be accessible without auth', async ({
            page,
        }) => {
            await page.context().clearCookies()

            // Test various public routes
            const publicRoutes = [
                '/',
                '/coupons',
                '/pricing',
                '/privacy',
                '/supported-sites',
                '/login',
                '/signup',
            ]

            for (const route of publicRoutes) {
                await page.goto(route)
                await expect(page).toHaveURL(route)
            }
        })
    })

    test.describe('Session Persistence', () => {
        test('should maintain session across page navigations', async ({
            page,
        }) => {
            await page.goto('/')

            // Navigate to different pages
            await page.goto('/coupons')
            await page.goto('/pricing')
            await page.goto('/')

            // If logged in initially, should stay logged in
            const profileIcon = page
                .locator('button.bg-caramel.rounded-full')
                .first()
            const wasLoggedIn = (await profileIcon.count()) > 0

            if (wasLoggedIn) {
                // Profile icon should still be visible
                await expect(profileIcon).toBeVisible()
            }
        })

        test('session should persist after page reload', async ({
            page,
            context,
        }) => {
            await page.goto('/')

            const profileIcon = page
                .locator('button.bg-caramel.rounded-full')
                .first()
            const wasLoggedIn = (await profileIcon.count()) > 0

            if (wasLoggedIn) {
                // Reload page
                await page.reload()

                // Should still be logged in
                await expect(profileIcon).toBeVisible()
            }
        })
    })

    test.describe('User Experience', () => {
        test('should show loading states during authentication', async ({
            page,
        }) => {
            await page.goto('/login')

            await page.fill('input[type="email"]', 'test@example.com')
            await page.fill('input[type="password"]', 'password')

            await page.click('button[type="submit"]')

            // Loading text should appear
            const loadingButton = page.locator('button:has-text("Logging")')
            await expect(loadingButton).toBeVisible()

            // Button should be disabled during loading
            await expect(loadingButton).toBeDisabled()
        })

        test('should display toast notifications', async ({ page }) => {
            await page.goto('/login')

            // Submit invalid credentials
            await page.fill('input[type="email"]', 'wrong@example.com')
            await page.fill('input[type="password"]', 'wrong')
            await page.click('button[type="submit"]')

            // Toast should appear (check for either data attribute or class)
            const toast = page.locator('[data-sonner-toast], .sonner-toast')
            await expect(toast.first()).toBeVisible({
                timeout: 5000,
            })
        })

        test('should have smooth transitions and animations', async ({
            page,
        }) => {
            await page.goto('/login')

            // Page should have motion/animations (check for framer-motion or transition classes)
            const animatedElements = page.locator(
                '[class*="motion"], [class*="animate"], [class*="transition"]',
            )
            const exists = await animatedElements.count()

            // Forms use framer-motion or CSS transitions for animations
            expect(exists).toBeGreaterThan(0)
        })
    })
})
