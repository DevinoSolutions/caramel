import { cors } from '@/lib/cors'
import prisma from '@/lib/prisma'
import jwt from 'jsonwebtoken'
import { NextRequest, NextResponse } from 'next/server'

interface GoogleAuthBody {
    idToken: string
    email: string
    name: string
    picture?: string
}

interface GoogleAuthResponse {
    token: string
    username: string | null
    image: string | null
}

export async function POST(req: NextRequest) {
    // Handle CORS
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return new NextResponse(null, { status: 200, headers: corsHeaders })
    }

    try {
        const body: GoogleAuthBody = await req.json()
        const { idToken, email, name, picture } = body

        if (!email || !name) {
            return NextResponse.json(
                { error: 'Missing required fields' },
                { status: 400, headers: corsHeaders }
            )
        }

        // Find or create user
        let user = await prisma.user.findUnique({
            where: { email: email.toLowerCase() },
        })

        if (!user) {
            // Create new user with Google account
            user = await prisma.user.create({
                data: {
                    email: email.toLowerCase(),
                    name: name,
                    username: name.toLowerCase().replace(/\s+/g, ''),
                    image: picture,
                    status: 'ACTIVE_USER',
                },
            })

            // Create account record for Google
            await prisma.account.create({
                data: {
                    userId: user.id,
                    type: 'oauth',
                    provider: 'google',
                    providerAccountId: idToken, // This should be the Google user ID, but we'll use idToken for now
                    access_token: idToken,
                },
            })
        } else {
            // Update existing user if needed
            if (!user.image && picture) {
                await prisma.user.update({
                    where: { id: user.id },
                    data: { image: picture },
                })
            }
        }

        if (!process.env.JWT_SECRET) {
            return NextResponse.json(
                { error: 'Internal server error' },
                { status: 500, headers: corsHeaders }
            )
        }

        const token = jwt.sign(
            {
                sub: user.id,
                email: user.email,
            },
            process.env.JWT_SECRET,
            { expiresIn: '1d' },
        )

        const response: GoogleAuthResponse = {
            token,
            username: user.username,
            image: user.image,
        }

        return NextResponse.json(response, { status: 200, headers: corsHeaders })
    } catch (error) {
        console.error('Google auth error:', error)
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500, headers: corsHeaders }
        )
    }
}
