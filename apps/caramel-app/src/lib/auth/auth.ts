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
const appleIdTrustedOrigins = ['https://appleid.apple.com']
const googleOAuthConfigured = !!(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
)
const appleOAuthConfigured = !!(
    process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET
)
const socialProviders = {
    ...(googleOAuthConfigured
        ? {
              google: {
                  clientId: process.env.GOOGLE_CLIENT_ID as string,
                  clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
                  prompt: 'select_account' as const,
              },
          }
        : {}),
    ...(appleOAuthConfigured
        ? {
              apple: {
                  clientId: process.env.APPLE_CLIENT_ID as string,
                  clientSecret: process.env.APPLE_CLIENT_SECRET as string,
                  // Use production domain for Apple redirect URI (Apple doesn't accept localhost)
                  // The callback will be handled on production, then redirect back to localhost
                  redirectURI:
                      process.env.APPLE_REDIRECT_URI ||
                      'https://grabcaramel.com/api/auth/callback/apple',
              },
          }
        : {}),
}
const hasSocialProviders = Object.keys(socialProviders).length > 0
const baseURL =
    process.env.BETTER_AUTH_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    fallbackBaseURL
const trustedOrigins = Array.from(
    new Set(
        [
            process.env.NEXT_PUBLIC_BASE_URL || '',
            baseURL,
            ...appleIdTrustedOrigins,
        ].filter(Boolean),
    ),
)

// Detect if baseURL uses HTTPS (required for secure cookies with ngrok/tunnels)
const isHTTPS = baseURL.startsWith('https://')
// SameSite=None requires Secure; browsers silently reject None+insecure cookies.
// In non-HTTPS local dev we fall back to Lax (sufficient for GET-redirect providers
// like Google). Apple requires None, but also requires HTTPS anyway (ngrok/tunnel).
const useSecure = isHTTPS || process.env.NODE_ENV === 'production'

export const auth = betterAuth({
    database: prismaAdapter(prisma, {
        provider: 'postgresql',
    }),
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
    ...(hasSocialProviders ? { socialProviders } : {}),
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
        // Enable secure cookies when using HTTPS (required for ngrok/tunnels)
        // This ensures cookies are properly sent during OAuth redirects
        useSecureCookies: useSecure,
        // SameSite=None so state cookie is sent when OAuth provider POSTs back to our callback.
        // Apple (and some others) use a cross-site POST; Lax would block cookies on that request.
        // Only use None when Secure is true (spec requirement); fall back to Lax for HTTP dev.
        defaultCookieAttributes: {
            sameSite: useSecure ? 'none' : 'lax',
        },
    },
    plugins: [bearer()],
})
