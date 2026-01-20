// apps/caramel-app/src/app/api/user/profile/route.ts
import { auth } from '@/lib/auth/auth'
import prisma from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'

export async function PATCH(req: NextRequest) {
    const session = await auth.api.getSession({ headers: req.headers })

    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { name, username } = await req.json()

    const updated = await prisma.user.update({
        where: { id: session.user.id },
        data: { name, username },
    })

    return NextResponse.json(updated)
}
