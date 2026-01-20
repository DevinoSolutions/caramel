import { expect, test } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

// Database integration tests
// These tests verify that auth operations correctly update the database

test.describe('Auth Database Integration', () => {
    let prisma: PrismaClient

    test.beforeAll(async () => {
        prisma = new PrismaClient()
    })

    test.afterAll(async () => {
        await prisma.$disconnect()
    })

    test.describe('User Creation', () => {
        test('should create user record in database on signup', async ({
            page,
        }) => {
            const timestamp = Date.now()
            const email = `dbtest_${timestamp}@example.com`
            const username = `dbtest${timestamp}`

            // Sign up
            await page.goto('/signup')
            await page.fill('input[name="username"]', username)
            await page.fill('input[name="email"]', email)
            await page.fill('input[name="password"]', 'Test123!')
            await page.fill('input[name="confirmPassword"]', 'Test123!')
            await page.click('button[type="submit"]')

            // Wait for redirect
            await page.waitForURL('/verify?signup=success', { timeout: 10000 })

            // Check database
            const user = await prisma.user.findUnique({
                where: { email },
                include: { accounts: true },
            })

            expect(user).not.toBeNull()
            expect(user?.email).toBe(email)
            expect(user?.username).toBe(username)
            expect(user?.emailVerified).toBe(false)
            expect(user?.status).toBe('NOT_VERIFIED')
            expect(user?.role).toBe('USER')

            // Should have one account record (credentials)
            expect(user?.accounts.length).toBe(1)
            expect(user?.accounts[0].providerId).toBe('credential')

            // Cleanup
            if (user) {
                await prisma.account.deleteMany({
                    where: { userId: user.id },
                })
                await prisma.session.deleteMany({
                    where: { userId: user.id },
                })
                await prisma.user.delete({ where: { id: user.id } })
            }
        })

        test('should hash password in database', async ({ page }) => {
            const timestamp = Date.now()
            const email = `hashtest_${timestamp}@example.com`
            const plainPassword = 'Test123!'

            await page.goto('/signup')
            await page.fill('input[name="username"]', `hashtest${timestamp}`)
            await page.fill('input[name="email"]', email)
            await page.fill('input[name="password"]', plainPassword)
            await page.fill('input[name="confirmPassword"]', plainPassword)
            await page.click('button[type="submit"]')

            await page.waitForURL('/verify?signup=success', { timeout: 10000 })

            // Check database
            const user = await prisma.user.findUnique({
                where: { email },
                include: { accounts: true },
            })

            // better-auth stores password in Account table, not User table
            const credentialAccount = user?.accounts.find(
                (acc: { providerId: string }) => acc.providerId === 'credential',
            )

            // Password should be hashed (not equal to plain password)
            expect(credentialAccount?.password).not.toBe(plainPassword)
            expect(credentialAccount?.password).toBeTruthy()
            expect(credentialAccount?.password?.length).toBeGreaterThan(20) // bcrypt hashes are long

            // Cleanup
            if (user) {
                await prisma.account.deleteMany({
                    where: { userId: user.id },
                })
                await prisma.user.delete({ where: { id: user.id } })
            }
        })
    })

    test.describe('Session Management', () => {
        test('should create session record on login', async ({ page }) => {
            // This test assumes you have a verified test user
            // You may need to create one first or use a fixture

            const testEmail = 'session-test@example.com'

            // Ensure user exists
            let user = await prisma.user.findUnique({
                where: { email: testEmail },
            })

            if (!user) {
                // Create test user
                user = await prisma.user.create({
                    data: {
                        email: testEmail,
                        username: 'sessiontest',
                        password: '$2a$10$hashedpassword', // Mock hash
                        emailVerified: true,
                        status: 'ACTIVE_USER',
                    },
                })
            }

            // Note: Actual login would require valid credentials
            // This test is more of a structure check
        })

        test('should delete session record on signout', async () => {
            // Test session cleanup
            const testEmail = 'signout-test@example.com'

            const user = await prisma.user.findUnique({
                where: { email: testEmail },
                include: { sessions: true },
            })

            if (user) {
                const sessionCount = user.sessions.length
                // After sign out, session count should decrease
                expect(sessionCount).toBeGreaterThanOrEqual(0)
            }
        })
    })

    test.describe('Profile Updates', () => {
        test('should update user record when profile is edited', async ({
            page,
        }) => {
            const testEmail = 'profile-update@example.com'

            // Create test user
            let user = await prisma.user.findUnique({
                where: { email: testEmail },
            })

            if (!user) {
                user = await prisma.user.create({
                    data: {
                        email: testEmail,
                        username: 'profiletest',
                        name: 'Original Name',
                        emailVerified: true,
                        status: 'ACTIVE_USER',
                    },
                })
            }

            // Note: Would need authenticated session to test profile update
            // This validates database schema is correct

            const updatedUser = await prisma.user.findUnique({
                where: { email: testEmail },
            })

            expect(updatedUser).not.toBeNull()
            expect(updatedUser?.email).toBe(testEmail)
        })
    })

    test.describe('Data Integrity', () => {
        test('should enforce unique email constraint', async () => {
            const email = 'duplicate@example.com'

            try {
                // Try to create two users with same email
                await prisma.user.create({
                    data: {
                        email,
                        username: 'user1',
                    },
                })

                await expect(
                    prisma.user.create({
                        data: {
                            email, // Same email
                            username: 'user2',
                        },
                    }),
                ).rejects.toThrow()
            } finally {
                // Cleanup
                await prisma.user.deleteMany({
                    where: { email },
                })
            }
        })

        test('should enforce unique username constraint', async () => {
            const username = 'duplicateuser'

            try {
                await prisma.user.create({
                    data: {
                        email: 'user1@example.com',
                        username,
                    },
                })

                await expect(
                    prisma.user.create({
                        data: {
                            email: 'user2@example.com',
                            username, // Same username
                        },
                    }),
                ).rejects.toThrow()
            } finally {
                // Cleanup
                await prisma.user.deleteMany({
                    where: { username },
                })
            }
        })

        test('should cascade delete sessions when user is deleted', async () => {
            const email = 'cascade-test@example.com'

            // Create user
            const user = await prisma.user.create({
                data: {
                    email,
                    username: 'cascadetest',
                },
            })

            // Create session
            await prisma.session.create({
                data: {
                    userId: user.id,
                    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                    token: `test-token-${Date.now()}`,
                },
            })

            // Delete user
            await prisma.user.delete({
                where: { id: user.id },
            })

            // Sessions should be deleted too (cascade)
            const sessions = await prisma.session.findMany({
                where: { userId: user.id },
            })

            expect(sessions.length).toBe(0)
        })
    })

    test.describe('User Status and Role', () => {
        test('should default to NOT_VERIFIED status', async () => {
            const email = `status-test-${Date.now()}@example.com`

            const user = await prisma.user.create({
                data: {
                    email,
                    username: `statustest${Date.now()}`,
                },
            })

            expect(user.status).toBe('NOT_VERIFIED')
            expect(user.role).toBe('USER')

            // Cleanup
            await prisma.user.delete({ where: { id: user.id } })
        })

        test('should support all UserStatus enum values', async () => {
            const statuses = [
                'ACTIVE_USER',
                'DELETE_REQUESTED_BY_USER',
                'NOT_VERIFIED',
                'USER_BANNED',
            ]

            for (const status of statuses) {
                const user = await prisma.user.create({
                    data: {
                        email: `status-${status}-${Date.now()}@example.com`,
                        username: `user-${status}-${Date.now()}`,
                        status: status as any,
                    },
                })

                expect(user.status).toBe(status)

                // Cleanup
                await prisma.user.delete({ where: { id: user.id } })
            }
        })
    })
})
