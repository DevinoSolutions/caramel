import prisma from '@/lib/prisma'
import { PrismaAdapter } from '@next-auth/prisma-adapter'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import GoogleProvider from 'next-auth/providers/google'

export const authOptions: NextAuthOptions = {
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
                if (!credentials?.email || !credentials?.password)
                    throw new Error('Missing credentials')
                const { email, password } = credentials
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
                user.name = user.name || user.username
                return user as any
            },
        }),
    ],
    session: { strategy: 'jwt' },
    cookies: {
        csrfToken: {
            name: `next-auth.csrf-token`,
            options: {
                httpOnly: true,
                sameSite: 'none',
                path: '/',
                secure: true,
            },
        },
        pkceCodeVerifier: {
            name: `next-auth.pkce.code_verifier`,
            options: {
                httpOnly: true,
                sameSite: 'none',
                path: '/',
                secure: true,
            },
        },
    },
    secret: process.env.JWT_SECRET,
    callbacks: {
        async jwt({ token, user }: any) {
            if (user && process.env.JWT_SECRET) {
                ;(token as any).id = (user as any).id
                ;(token as any).accessToken = jwt.sign(
                    { id: (user as any).id, username: (user as any).username },
                    process.env.JWT_SECRET,
                    { expiresIn: '1h' },
                )
            }
            return token
        },
        async session({ session, token }: any) {
            const dbUser = await prisma.user.findUnique({
                where: { id: (token as any).id as string },
                select: { id: true, username: true, email: true },
            })
            if (!dbUser) return session
            ;(session as any).user = { ...session.user, ...dbUser }
            ;(session as any).accessToken = (token as any).accessToken as string
            return session
        },
    },
    pages: { signIn: '/login' },
}
