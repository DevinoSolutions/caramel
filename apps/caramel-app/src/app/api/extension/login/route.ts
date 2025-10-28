import prisma from '@/lib/prisma'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
    const { email, password } = (await req.json().catch(() => ({}))) as {
        email?: string
        password?: string
    }
    if (!email || !password)
        return NextResponse.json(
            { error: 'Missing email or password' },
            { status: 400 },
        )
    try {
        const user = await prisma.user.findUnique({ where: { email } })
        if (!user || !user.password)
            return NextResponse.json(
                { error: 'Invalid credentials' },
                { status: 401 },
            )
        const isValid = await bcrypt.compare(password, user.password)
        if (!isValid)
            return NextResponse.json(
                { error: 'Invalid credentials' },
                { status: 401 },
            )
        if (!process.env.JWT_SECRET)
            return NextResponse.json(
                { error: 'Internal server error' },
                { status: 500 },
            )
        const token = jwt.sign(
            { sub: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '1d' },
        )
        return NextResponse.json({
            token,
            username: user.username,
            image: user.image || null,
        })
    } catch {
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 },
        )
    }
}
