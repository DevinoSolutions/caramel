import VerificationRequestTemplate from '@/emails/VerificationRequestTemplate'
import { nextApiResponse } from '@/lib/apiResponseNext'
import { sendEmail } from '@/lib/email'
import prisma from '@/lib/prisma'
import { render } from '@react-email/render'
import bcrypt from 'bcryptjs'
import { NextRequest } from 'next/server'

export async function POST(req: NextRequest) {
    try {
        const body = (await req.json().catch(() => ({}))) as {
            username?: string
            email?: string
            password?: string
        }
        const username = (body.username || '').trim()
        const email = (body.email || '').trim().toLowerCase()
        const password = body.password || ''

        if (!email || !password || !username) {
            return nextApiResponse(
                req,
                400,
                'Missing required fields',
                null,
                'Missing required fields',
            )
        }

        const existingUser = await prisma.user.findUnique({ where: { email } })
        if (existingUser) {
            return nextApiResponse(
                req,
                400,
                'Email already exists',
                null,
                'Email already exists',
            )
        }
        const existingUsername = await prisma.user.findUnique({
            where: { username },
        })
        if (existingUsername) {
            return nextApiResponse(
                req,
                400,
                'Username already exists',
                null,
                'Username already exists',
            )
        }

        const hashedPassword = bcrypt.hashSync(
            password,
            Number(process.env.BCRYPT_SALT_ROUNDS) || 10,
        )
        const verificationToken =
            Math.random().toString(36).slice(2) +
            Math.random().toString(36).slice(2)

        await prisma.user.create({
            data: {
                username,
                email,
                password: hashedPassword,
                token: verificationToken,
                tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
            },
        })

        const html = await render(
            VerificationRequestTemplate({ token: verificationToken }),
        )
        await sendEmail({
            to: email,
            subject: 'Verify your email for Caramel',
            html,
        })

        return nextApiResponse(req, 200, 'User created successfully')
    } catch (error: any) {
        return nextApiResponse(
            req,
            500,
            'Error creating user',
            null,
            error?.message,
        )
    }
}
