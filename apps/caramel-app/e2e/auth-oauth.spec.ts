import { expect, test } from '@playwright/test'

test.describe('OAuth Authentication', () => {
    const baseURL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:58000'

    test.beforeEach(async ({ page }) => {
        await page.goto('/')
    })

    test.describe('Google OAuth - Sign Up', () => {
        test('should display Google sign-in button on signup page', async ({
            page,
        }) => {
            await page.goto('/signup')
            
            // Check for Google button
            const googleButton = page.getByRole('button', {
                name: /sign in with google/i,
            })
            await expect(googleButton).toBeVisible()
            
            // Verify button styling
            await expect(googleButton).toHaveClass(/border-gray-300/)
        })

        test('should redirect to Google OAuth when clicked', async ({
            page,
        }) => {
            await page.goto('/signup')

            // Click Google sign-in button
            const googleButton = page.getByRole('button', {
                name: /sign in with google/i,
            })

            // Wait for navigation
            const [popup] = await Promise.all([
                page.waitForEvent('popup'),
                googleButton.click(),
            ])

            // Verify redirected to Google
            await popup.waitForLoadState()
            expect(popup.url()).toContain('accounts.google.com')
        })

        test('should handle Google OAuth cancellation gracefully', async ({
            page,
        }) => {
            await page.goto('/signup')

            const googleButton = page.getByRole('button', {
                name: /sign in with google/i,
            })

            const [popup] = await Promise.all([
                page.waitForEvent('popup'),
                googleButton.click(),
            ])

            // Close the popup (simulate user cancellation)
            await popup.close()

            // Verify user remains on signup page
            await expect(page).toHaveURL('/signup')
            
            // No error messages should appear
            const errorToast = page.locator('.sonner-toast')
            await expect(errorToast).not.toBeVisible()
        })
    })

    test.describe('Apple OAuth - Sign Up', () => {
        test('should display Apple sign-in button on signup page', async ({
            page,
        }) => {
            await page.goto('/signup')

            // Check for Apple button
            const appleButton = page.getByRole('button', {
                name: /sign in with apple/i,
            })
            await expect(appleButton).toBeVisible()

            // Verify black button styling
            await expect(appleButton).toHaveClass(/bg-black/)
        })

        test('should redirect to Apple OAuth when clicked', async ({
            page,
        }) => {
            await page.goto('/signup')

            const appleButton = page.getByRole('button', {
                name: /sign in with apple/i,
            })

            const [popup] = await Promise.all([
                page.waitForEvent('popup'),
                appleButton.click(),
            ])

            await popup.waitForLoadState()
            expect(popup.url()).toContain('appleid.apple.com')
        })
    })

    test.describe('OAuth - Login Page', () => {
        test('should display OAuth buttons on login page', async ({
            page,
        }) => {
            await page.goto('/login')

            // Both buttons should be visible
            const googleButton = page.getByRole('button', {
                name: /sign in with google/i,
            })
            const appleButton = page.getByRole('button', {
                name: /sign in with apple/i,
            })

            await expect(googleButton).toBeVisible()
            await expect(appleButton).toBeVisible()
        })

        test('should show "Or continue with" divider', async ({ page }) => {
            await page.goto('/login')

            const divider = page.getByText(/or continue with/i)
            await expect(divider).toBeVisible()
        })
    })

    test.describe('OAuth Button Styling', () => {
        test('Google button should have correct icon and styling', async ({
            page,
        }) => {
            await page.goto('/signup')

            const googleButton = page.getByRole('button', {
                name: /sign in with google/i,
            })

            // Check for Google icon
            const googleIcon = page.locator('img[alt="Google"]')
            await expect(googleIcon).toBeVisible()

            // Verify button is not disabled
            await expect(googleButton).toBeEnabled()
        })

        test('Apple button should have correct icon and styling', async ({
            page,
        }) => {
            await page.goto('/signup')

            const appleButton = page.getByRole('button', {
                name: /sign in with apple/i,
            })

            // Check for Apple icon
            const appleIcon = page.locator('img[alt="Apple"]')
            await expect(appleIcon).toBeVisible()

            // Verify button styling
            await expect(appleButton).toHaveClass(/bg-black/)
            await expect(appleButton).toHaveClass(/text-white/)
        })
    })

    test.describe('OAuth Mobile Responsiveness', () => {
        test('OAuth buttons should be visible on mobile', async ({
            page,
        }) => {
            // Set mobile viewport
            await page.setViewportSize({ width: 375, height: 667 })
            await page.goto('/signup')

            const googleButton = page.getByRole('button', {
                name: /sign in with google/i,
            })
            const appleButton = page.getByRole('button', {
                name: /sign in with apple/i,
            })

            await expect(googleButton).toBeVisible()
            await expect(appleButton).toBeVisible()

            // Buttons should be full width on mobile
            const googleBox = await googleButton.boundingBox()
            expect(googleBox?.width).toBeGreaterThan(290)
        })
    })
})
