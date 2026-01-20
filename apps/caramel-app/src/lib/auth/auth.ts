import VerificationRequestTemplate from '@/emails/VerificationRequestTemplate'
import { sendEmail } from '@/lib/email'
import prisma from '@/lib/prisma'
import { render } from '@react-email/render'
import bcrypt from 'bcryptjs'
import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { bearer } from 'better-auth/plugins'

const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS) || 10
const fallbackBaseURL = 'http://localhost:3000'
const baseURL =
    process.env.BETTER_AUTH_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    fallbackBaseURL
const trustedOrigins = Array.from(
    new Set([process.env.NEXT_PUBLIC_BASE_URL || '', baseURL, "https://appleid.apple.com"].filter(Boolean)), 
)

export const auth = betterAuth({
    database: prismaAdapter(prisma, {
        provider: 'postgresql',
    }),
    trustHost: true,
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        password: {
            hash: async (password: string) => bcrypt.hash(password, saltRounds),
            verify: async ({
                hash,
                password,
            }: {
                hash: string
                password: string
            }) => bcrypt.compare(password, hash),
        },
    },
    emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }) => {
            const html = await render(VerificationRequestTemplate({ url }))
            await sendEmail({
                to: user.email,
                subject: 'Verify your email for Caramel',
                html,
            })
        },
        callbackOnError: '/verify?error=token_expired',
    },
    user: {
        additionalFields: {
            username: {
                type: 'string',
                required: false,
            },
            firstName: {
                type: 'string',
                required: false,
            },
            lastName: {
                type: 'string',
                required: false,
            },
            role: {
                type: 'string',
                required: false,
                defaultValue: 'USER',
                input: false,
            },
            status: {
                type: 'string',
                required: false,
                defaultValue: 'NOT_VERIFIED',
                input: false,
            },
            encodedPictureUrl: {
                type: 'string',
                required: false,
            },
        },
    },
    session: {
        expiresIn: 60 * 60 * 24 * 7,
        updateAge: 60 * 60 * 24,
        cookieCache: {
            enabled: true,
            maxAge: 5 * 60,
        },
    },
    secret:
        process.env.BETTER_AUTH_SECRET ||
        process.env.JWT_SECRET ||
        'caramel-better-auth-secret',
    baseURL,
    trustedOrigins,
    advanced: {
        useSecureCookies: process.env.NODE_ENV === 'production',
        cookiePrefix: 'better-auth',
        defaultCookieAttributes: {
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            secure: process.env.NODE_ENV === 'production',
        },
    },
    socialProviders: {
        google: {
            //TODO : Add the env variables
            prompt: 'select_account',
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        },
        apple: {
            clientId: process.env.APPLE_CLIENT_ID!,
            clientSecret: process.env.APPLE_CLIENT_SECRET!,
        },
    },
    plugins: [bearer()],
})
