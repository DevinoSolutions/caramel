import prisma from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(
    _req: NextRequest,
    context: { params: Promise<{ token: string }> },
) {
    const { token } = await context.params
    if (!token)
        return NextResponse.json(
            { error: 'Token is required' },
            { status: 400 },
        )
    const user = await prisma.user.findUnique({ where: { token } })
    if (user) {
        await prisma.user.update({
            where: { id: user.id },
            data: { token: null, tokenExpiry: null, status: 'ACTIVE_USER' },
        })
    }
    return NextResponse.redirect(
        new URL(
            '/login',
            process.env.NEXT_PUBLIC_BASE_URL || 'https://grabcaramel.com',
        ),
    )
}
