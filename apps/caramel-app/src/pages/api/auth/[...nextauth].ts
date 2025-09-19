// pages/api/auth/[...nextauth].ts
import prisma from '@/lib/prisma'
import { PrismaAdapter } from '@next-auth/prisma-adapter'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import NextAuth from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import GoogleProvider from 'next-auth/providers/google'

export const authOptions = {
    adapter: PrismaAdapter(prisma),
    providers: [
        GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
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
                    where: { email: email.trim().toLowerCase() },
                    include: { accounts: true },
                })

                if (!user) throw new Error('User not found')

                if (user.status !== 'ACTIVE_USER')
                    throw new Error('User is inactive')

                if (!user.password)
                    throw new Error('No password set for this user')

                const passwordMatch = bcrypt.compareSync(
                    password,
                    user.password,
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
    // Your cookie settings can remain the same.
    cookies: {
        csrfToken: {
            name: `next-auth.csrf-token`,
            options: {
                httpOnly: true,
                sameSite: 'none' as const,
                path: '/',
                secure: true,
            },
        },
        pkceCodeVerifier: {
            name: `next-auth.pkce.code_verifier`,
            options: {
                httpOnly: true,
                sameSite: 'none' as const,
                path: '/',
                secure: true,
            },
        },
    },
    secret: process.env.JWT_SECRET,
    callbacks: {
        // The JWT callback is called whenever a token is created or updated.
        async jwt({ token, user }: any) {
            if (user && process.env.JWT_SECRET) {
                token.id = user.id
                // Generate an access token.
                token.accessToken = jwt.sign(
                    { id: user.id, username: (user as any).username },
                    process.env.JWT_SECRET,
                    { expiresIn: '1h' },
                )
            }
            return token
        },
        // The session callback shapes what is exposed to the client.
        async session({ session, token }: any) {
            // Retrieve only the relevant fields from the database.
            const dbUser = await prisma.user.findUnique({
                where: { id: token.id as string },
                select: {
                    id: true,
                    username: true,
                    email: true,
                },
            })
            if (!dbUser) return session

            // Expose only the minimal user info and the access token.
            session.user = {
                ...session.user,
                ...dbUser,
            }
            session.accessToken = token.accessToken as string
            return session
        },
    },
    pages: {
        signIn: '/login',
    },
}

export default NextAuth(authOptions)
