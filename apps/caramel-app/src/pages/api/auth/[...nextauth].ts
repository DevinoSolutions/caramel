// pages/api/auth/[...nextauth].ts
import prisma from '@/lib/prisma'
import { PrismaAdapter } from '@next-auth/prisma-adapter'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import NextAuth from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import GoogleProvider from 'next-auth/providers/google'
import AppleProvider from 'next-auth/providers/apple'

// Use JWT_SECRET as fallback since NEXTAUTH_SECRET is not set
const secret = process.env.NEXTAUTH_SECRET || process.env.JWT_SECRET

if (!secret) {
    throw new Error('No secret found. Please set NEXTAUTH_SECRET or JWT_SECRET in your environment variables.')
}

export const authOptions = {
    adapter: PrismaAdapter(prisma),
    providers: [
        GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        }),
        AppleProvider({
            clientId: process.env.APPLE_ID!,
            clientSecret: process.env.APPLE_SECRET!,
        }),
        CredentialsProvider({
            name: 'Credentials',
            credentials: {
                email: {
                    label: 'Email',
                    type: 'text',
                    placeholder: 'jsmith@gmail.com',
                },
                password: { label: 'Password', type: 'password' },
            },
            async authorize(credentials: any) {
                if (!credentials?.email || !credentials?.password) {
                    throw new Error('Missing credentials')
                }

                const { email, password } = credentials

                // Find user by email (case-insensitive) and include accounts
                const user = await prisma.user.findUnique({
                    where: { email: (email as string).trim().toLowerCase() },
                    include: { accounts: true },
                })

                if (!user) throw new Error('User not found')

                if (user.status !== 'ACTIVE_USER')
                    throw new Error('User is inactive')

                if (!user.password)
                    throw new Error('No password set for this user')

                const passwordMatch = bcrypt.compareSync(
                    password as string,
                    user.password!,
                )
                if (!passwordMatch) throw new Error('Incorrect password')

                // Set a display name if missing.
                user.name = user.name || user.username
                return user
            },
        }),
    ],
    session: {
        strategy: 'jwt' as const,
    },
    cookies: {
        csrfToken: {
            name: `next-auth.csrf-token`,
            options: {
                httpOnly: true,
                sameSite: 'lax' as const,
                path: '/',
                secure: process.env.NODE_ENV === 'production',
            },
        },
        pkceCodeVerifier: {
            name: `next-auth.pkce.code_verifier`,
            options: {
                httpOnly: true,
                sameSite: 'lax' as const,
                path: '/',
                secure: process.env.NODE_ENV === 'production',
            },
        },
        state: {
            name: `next-auth.state`,
            options: {
                httpOnly: true,
                sameSite: 'lax' as const,
                path: '/',
                secure: process.env.NODE_ENV === 'production',
                maxAge: 900, // 15 minutes
            },
        },
    },
    secret: secret,
    callbacks: {
        async signIn({ user, account, profile }: { user: any; account: any; profile?: any }) {
            
            // Ensure user has required fields for OAuth
            if (account?.provider === 'google' || account?.provider === 'apple') {
                if (!user.email) {
                    console.error('OAuth user missing email:', user)
                    return false
                }
                return true
            }
            // For credentials, use the existing logic
            return true
        },
        async redirect({ url, baseUrl }: { url: string; baseUrl: string }) {

            // IMPORTANT: NextAuth loses callbackUrl during OAuth flow
            // Force all OAuth sign-ins (which come as just baseUrl) to extension-callback
            // The callback page will handle both extension and web app users
            if (url === baseUrl || url === `${baseUrl}/`) {
                return `${baseUrl}/auth/extension-callback`
            }

            // If URL is for extension callback, allow it
            if (url.includes('/auth/extension-callback')) {
                return url
            }

            // If url is relative, prepend baseUrl
            if (url.startsWith('/')) {
                return `${baseUrl}${url}`
            }

            // If url is on same origin, allow it
            if (url.startsWith(baseUrl)) {
                return url
            }

            // Otherwise redirect to base URL
            return baseUrl
        },
        async jwt({ token, user, account }: { token: any; user: any; account: any }) {
            
            // Handle OAuth sign-ins
            if (account && user) {
                try {
                    // For OAuth providers, create or find user in database
                    if (account.provider === 'google' || account.provider === 'apple') {
                        if (!user.email) {
                            console.error('OAuth user missing email, cannot proceed')
                            throw new Error('OAuth user missing email')
                        }

                        let dbUser = await prisma.user.findUnique({
                            where: { email: user.email },
                        })

                        if (!dbUser) {
                            // Create new user for OAuth
                            dbUser = await prisma.user.create({
                                data: {
                                    email: user.email,
                                    name: user.name || user.email.split('@')[0],
                                    username: user.email.split('@')[0],
                                    status: 'ACTIVE_USER', // Set to ACTIVE_USER
                                    image: user.image,
                                },
                            })
                        } else {
                            // Update existing user status if needed
                            if (dbUser.status !== 'ACTIVE_USER') {
                                dbUser = await prisma.user.update({
                                    where: { id: dbUser.id },
                                    data: { status: 'ACTIVE_USER' },
                                })
                            }
                        }

                        token.id = dbUser.id
                        token.username = dbUser.username
                        token.email = dbUser.email
                    } else {
                        // For credentials provider
                        token.id = user.id
                        token.username = user.username
                        token.email = user.email
                    }

                    if (secret) {
                        token.accessToken = jwt.sign(
                            { id: token.id, username: token.username, email: token.email },
                            secret,
                            { expiresIn: '1h' },
                        )
                    }
                } catch (error) {
                    console.error('Error in JWT callback:', error)
                    throw error
                }
            }
            
            // If no user/account but token has data, return existing token
            // This handles subsequent requests where the token already exists
            if (!user && !account && token.id) {
                return token
            }
            
            return token
        },
        async session({ session, token }: { session: any; token: any }) {
            
            if (token.id) {
                try {
                    const dbUser = await prisma.user.findUnique({
                        where: { id: token.id as string },
                        select: {
                            id: true,
                            username: true,
                            email: true,
                            name: true,
                            image: true,
                            status: true,
                        },
                    })
                    
                    if (dbUser) {
                        session.user = {
                            ...session.user,
                            ...dbUser,
                        }
                    } else {
                        console.error('User not found in database for token.id:', token.id)
                    }
                } catch (error) {
                    console.error('Error in session callback:', error)
                }
            }
            
            if (token.accessToken) {
                session.accessToken = token.accessToken as string
            }
            
            return session
        },
    },
    pages: {
        signIn: '/login',
        error: '/login', // Redirect to login on OAuth errors
    },
}

export default NextAuth(authOptions)