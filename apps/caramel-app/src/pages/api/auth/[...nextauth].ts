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
            console.log('SignIn callback:', { 
                userEmail: user?.email, 
                accountProvider: account?.provider,
                userExists: !!user?.email 
            })
            
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
        async jwt({ token, user, account }: { token: any; user: any; account: any }) {
            console.log('JWT callback:', { 
                userEmail: user?.email, 
                accountProvider: account?.provider,
                hasUser: !!user,
                hasAccount: !!account
            })
            
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
                            console.log('Created new OAuth user:', { email: dbUser.email, id: dbUser.id })
                        } else {
                            // Update existing user status if needed
                            if (dbUser.status !== 'ACTIVE_USER') {
                                dbUser = await prisma.user.update({
                                    where: { id: dbUser.id },
                                    data: { status: 'ACTIVE_USER' },
                                })
                                console.log('Updated user status to ACTIVE_USER:', dbUser.email)
                            } else {
                                console.log('Found existing active user:', dbUser.email)
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
            return token
        },
        async session({ session, token }: { session: any; token: any }) {
            console.log('Session callback:', { 
                tokenId: token.id, 
                tokenEmail: token.email,
                sessionUserEmail: session.user?.email 
            })
            
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
                        console.log('Session updated with user data:', { 
                            email: dbUser.email, 
                            status: dbUser.status 
                        })
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
    debug: true, // Enable debug mode
    logger: {
        error(code: any, metadata: any) {
            console.error('NextAuth Error:', code, metadata)
        },
        warn(code: any) {
            console.warn('NextAuth Warning:', code)
        },
        debug(code: any, metadata: any) {
            console.log('NextAuth Debug:', code, metadata)
        },
    },
}

export default NextAuth(authOptions)