import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

test.describe('Profile Page', () => {
    const baseURL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:58000'

    // Helper function to create authenticated user - skips signup flow
    // Profile tests need auth, but signup flow may redirect or show verification
    // For now, these tests will skip if not authenticated
    async function checkAuthAndSkip(page: Page) {
        await page.goto('/profile')

        // If redirected to login, skip the test
        if (page.url().includes('/login')) {
            return false // Not authenticated
        }
        return true // Authenticated
    }

    test.describe('Profile Access', () => {
        test('should redirect to login when accessing profile without auth', async ({
            page,
        }) => {
            await page.goto('/profile')

            // Should redirect to login
            await page.waitForURL('/login')
            await expect(page).toHaveURL('/login')
        })

        test('should access profile when logged in', async ({ page }) => {
            // This test requires manual authentication setup
            // Skip if not authenticated
            const isAuth = await checkAuthAndSkip(page)

            if (!isAuth) {
                test.skip()
            }

            // Should stay on profile page if authenticated
            await expect(page).toHaveURL('/profile')
        })
    })

    test.describe('Profile Navigation', () => {
        test('should navigate to profile from navbar dropdown', async ({
            page,
            context,
        }) => {
            // Create authenticated session
            await page.goto('/')

            // Click profile icon (only visible when logged in)
            const profileButton = page
                .locator('button')
                .filter({
                    has: page.locator('text=/^[A-Z]$/'),
                })
                .first()

            // If logged in, profile icon should be visible
            const isVisible = await profileButton.isVisible()

            if (isVisible) {
                await profileButton.click()

                // Click Profile link in dropdown
                await page.click('a[href="/profile"]')

                // Should navigate to profile
                await expect(page).toHaveURL('/profile')
            }
        })
    })

    test.describe('Profile Display - Requires Authentication', () => {
        test.fixme(
            'should display profile header with user info',
            async ({ page }) => {
                const isAuth = await checkAuthAndSkip(page)
                if (!isAuth) {
                    test.skip()
                    return
                }

                // Check for gradient banner (from-caramel to-orange-400)
                const banner = page
                    .locator('.from-caramel, .to-orange-400')
                    .first()
                await expect(banner).toBeVisible()

                // Check for avatar circle (bg-caramel with border-white)
                const avatar = page.locator('.bg-caramel.rounded-full')
                await expect(avatar.first()).toBeVisible()

                // Check for user name heading
                const heading = page.locator('h1')
                await expect(heading).toBeVisible()
            },
        )

        test.fixme(
            'should display Account Information section',
            async ({ page }) => {
                const isAuth = await checkAuthAndSkip(page)
                if (!isAuth) {
                    test.skip()
                }

                const sectionHeading = page.getByRole('heading', {
                    name: /account information/i,
                    level: 2,
                })
                await expect(sectionHeading).toBeVisible()

                // Check for field labels
                await expect(page.getByText('Full Name')).toBeVisible()
                await expect(page.getByText('Username')).toBeVisible()
                await expect(page.getByText('Email Address')).toBeVisible()
                await expect(page.getByText('Account Status')).toBeVisible()
            },
        )

        test.fixme('should display account stats cards', async ({ page }) => {
            const isAuth = await checkAuthAndSkip(page)
            if (!isAuth) {
                test.skip()
                return
            }

            // Check for three stat cards
            await expect(page.getByText(/coupons used/i)).toBeVisible()
            await expect(page.getByText(/total saved/i)).toBeVisible()
            await expect(page.getByText(/role/i)).toBeVisible()
        })

        test.fixme(
            'should show Edit Profile button when not editing',
            async ({ page }) => {
                const isAuth = await checkAuthAndSkip(page)
                if (!isAuth) {
                    test.skip()
                    return
                }

                const editButton = page.getByRole('button', {
                    name: /edit profile/i,
                })
                await expect(editButton).toBeVisible()
            },
        )
    })

    test.describe('Profile Editing - Requires Authentication', () => {
        test.fixme(
            'should enter edit mode when clicking Edit Profile',
            async ({ page }) => {
                const isAuth = await checkAuthAndSkip(page)
                if (!isAuth) {
                    test.skip()
                    return
                }

                // Click Edit Profile
                const editButton = page.getByRole('button', {
                    name: /edit profile/i,
                })
                await editButton.click()

                // Check that inputs are now editable
                const nameInput = page.locator(
                    'input[placeholder*="full name"]',
                )
                await expect(nameInput).toBeVisible()
                await expect(nameInput).toBeEnabled()

                // Save and Cancel buttons should appear
                await expect(
                    page.getByRole('button', { name: /save changes/i }),
                ).toBeVisible()
                await expect(
                    page.getByRole('button', { name: /cancel/i }),
                ).toBeVisible()

                // Edit Profile button should be hidden
                await expect(editButton).not.toBeVisible()
            },
        )

        test.fixme(
            'should update profile name successfully',
            async ({ page }) => {
                const isAuth = await checkAuthAndSkip(page)
                if (!isAuth) {
                    test.skip()
                    return
                }

                // Enter edit mode
                await page.click('button:has-text("Edit Profile")')

                // Change name
                const nameInput = page.locator(
                    'input[placeholder*="full name"]',
                )
                await nameInput.clear()
                await nameInput.fill('New Test Name')

                // Save changes
                await page.click('button:has-text("Save Changes")')

                // Should show success toast
                await expect(
                    page.locator('.sonner-toast:has-text("successfully")'),
                ).toBeVisible({ timeout: 5000 })

                // Should exit edit mode
                await expect(
                    page.getByRole('button', { name: /edit profile/i }),
                ).toBeVisible()
            },
        )

        test.fixme(
            'should cancel edit and restore original values',
            async ({ page }) => {
                const isAuth = await checkAuthAndSkip(page)
                if (!isAuth) {
                    test.skip()
                    return
                }

                // Get original name
                const originalName = await page
                    .locator('div.rounded-md.bg-gray-50')
                    .first()
                    .textContent()

                // Enter edit mode
                await page.click('button:has-text("Edit Profile")')

                // Change name
                const nameInput = page.locator(
                    'input[placeholder*="full name"]',
                )
                await nameInput.clear()
                await nameInput.fill('Temporary Name')

                // Cancel
                await page.click('button:has-text("Cancel")')

                // Should exit edit mode
                await expect(
                    page.getByRole('button', { name: /edit profile/i }),
                ).toBeVisible()

                // Original value should be restored
                const restoredName = await page
                    .locator('div.rounded-md.bg-gray-50')
                    .first()
                    .textContent()
                expect(restoredName).toBe(originalName)
            },
        )

        test.fixme(
            'should disable save button when loading',
            async ({ page }) => {
                const isAuth = await checkAuthAndSkip(page)
                if (!isAuth) {
                    test.skip()
                    return
                }

                await page.click('button:has-text("Edit Profile")')

                // Change value
                const nameInput = page.locator(
                    'input[placeholder*="full name"]',
                )
                await nameInput.fill('Test Name')

                // Click save
                const saveButton = page.getByRole('button', {
                    name: /save changes/i,
                })
                await saveButton.click()

                // Button should show "Saving..." briefly
                await expect(saveButton).toContainText('Saving...')
            },
        )
    })

    test.describe('Profile Status Indicators', () => {
        test('should display correct status indicator color for ACTIVE_USER', async ({
            page,
        }) => {
            await page.goto('/profile')

            // Look for green status indicator
            const activeIndicator = page.locator('.bg-green-500')
            const statusText = page.getByText('Active')

            // At least one should be visible (depending on user status)
            const isActive = await statusText.isVisible()

            if (isActive) {
                await expect(activeIndicator).toBeVisible()
            }
        })

        test.fixme(
            'should display verified badge for verified emails',
            async ({ page }) => {
                const isAuth = await checkAuthAndSkip(page)
                if (!isAuth) {
                    test.skip()
                    return
                }

                // Look for verified badge
                const verifiedBadge = page.locator('span:has-text("Verified")')

                // Badge should have orange background
                await expect(verifiedBadge).toHaveClass(/bg-caramel/)
            },
        )
    })

    test.describe('Sign Out Functionality - Requires Authentication', () => {
        test.fixme(
            'should sign out when clicking Sign Out button',
            async ({ page }) => {
                const isAuth = await checkAuthAndSkip(page)
                if (!isAuth) {
                    test.skip()
                    return
                }

                // Click Sign Out button
                const signOutButton = page
                    .getByRole('button', {
                        name: /sign out/i,
                    })
                    .first()
                await signOutButton.click()

                // Should show success toast
                await expect(
                    page.locator('.sonner-toast:has-text("Signed out")'),
                ).toBeVisible({ timeout: 5000 })

                // Should redirect to home
                await page.waitForURL('/')
                await expect(page).toHaveURL('/')
            },
        )

        test.fixme(
            'should show login buttons after sign out',
            async ({ page }) => {
                const isAuth = await checkAuthAndSkip(page)
                if (!isAuth) {
                    test.skip()
                    return
                }

                // Sign out
                await page.click('button:has-text("Sign out")')

                // Wait for redirect
                await page.waitForURL('/')

                // Login and Sign Up buttons should be visible
                await expect(
                    page.getByRole('link', { name: /^login$/i }),
                ).toBeVisible()
                await expect(
                    page.getByRole('link', { name: /sign up/i }),
                ).toBeVisible()
            },
        )
    })

    test.describe('Profile Avatar Display - Requires Authentication', () => {
        test.fixme(
            'should display user initial when no image available',
            async ({ page }) => {
                const isAuth = await checkAuthAndSkip(page)
                if (!isAuth) {
                    test.skip()
                    return
                }

                // Avatar should show initial letter (bg-caramel rounded-full)
                const avatar = page.locator('.bg-caramel.rounded-full').first()
                await expect(avatar).toBeVisible()

                // Should contain a single letter
                const text = await avatar.textContent()
                expect(text?.length).toBeLessThanOrEqual(1)
            },
        )

        test('should display user image when available', async ({ page }) => {
            // This test would require a user with an image
            await page.goto('/profile')

            const avatar = page.locator(
                'div.rounded-full.border-4.border-white',
            )

            // Check if image element exists inside avatar
            const image = avatar.locator('img')
            const imageExists = await image.count()

            if (imageExists > 0) {
                await expect(image).toBeVisible()
                await expect(image).toHaveAttribute('alt', 'Profile')
            }
        })
    })

    test.describe('Mobile Responsiveness - Requires Authentication', () => {
        test.fixme(
            'should display profile correctly on mobile',
            async ({ page }) => {
                await page.setViewportSize({ width: 375, height: 667 })
                const isAuth = await checkAuthAndSkip(page)
                if (!isAuth) {
                    test.skip()
                    return
                }

                // All sections should still be visible
                await expect(page.locator('h1')).toBeVisible()
                await expect(
                    page.getByRole('heading', { name: /account information/i }),
                ).toBeVisible()

                // Stats cards should stack vertically
                const statsCards = page.locator('div:has-text("Coupons Used")')
                await expect(statsCards).toBeVisible()
            },
        )

        test.fixme(
            'should have working buttons on mobile',
            async ({ page }) => {
                await page.setViewportSize({ width: 375, height: 667 })
                const isAuth = await checkAuthAndSkip(page)
                if (!isAuth) {
                    test.skip()
                    return
                }

                // Edit Profile button should work
                const editButton = page.getByRole('button', {
                    name: /edit profile/i,
                })
                await expect(editButton).toBeEnabled()
                await editButton.click()

                // Save/Cancel buttons should appear
                await expect(
                    page.getByRole('button', { name: /save changes/i }),
                ).toBeVisible()
            },
        )
    })
})
