import { withRoute } from '@/lib/api/withRoute'
import { auth } from '@/lib/auth/auth'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// Strict — previously had NO rate limit despite calling into better-auth's
// password verification (F-007's flagged gap). Missing email/password now
// 422s instead of the old manual 400 "Missing email or password"
// (§Breaking); the manual check is now redundant (the wrapper guarantees
// both fields non-empty before the handler runs) and has been dropped.
const LoginBodySchema = z.object({
    email: z.string().min(1),
    password: z.string().min(1),
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'extension/login',
        rateLimit: 'mutation',
        body: LoginBodySchema,
    },
    async ({ body }) => {
        const { email, password } = body
        try {
            const response = await auth.api.signInEmail({
                body: { email, password },
                asResponse: true,
            })

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}))
                const errorMessage =
                    errorData?.message ||
                    errorData?.error?.message ||
                    'Invalid credentials'

                // Check if error is about email verification
                const isVerificationError =
                    errorData?.error?.code === 'EMAIL_NOT_VERIFIED' ||
                    errorMessage.toLowerCase().includes('verify')

                return NextResponse.json(
                    {
                        error: isVerificationError
                            ? 'Please verify your email first. Check your inbox for the verification link.'
                            : errorMessage,
                    },
                    { status: 401 },
                )
            }

            const token = response.headers.get('set-auth-token')
            const data = await response.json()

            if (!token) {
                return NextResponse.json(
                    { error: 'Failed to generate token' },
                    { status: 500 },
                )
            }

            return NextResponse.json({
                token,
                username:
                    data.user?.username ||
                    data.user?.name ||
                    data.user?.email ||
                    null,
                image: data.user?.image || null,
            })
        } catch {
            return NextResponse.json(
                { error: 'Internal server error' },
                { status: 500 },
            )
        }
    },
)
