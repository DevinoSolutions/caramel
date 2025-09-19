import { cors } from '@/lib/cors'
import prisma from '@/lib/prisma'
import jwt from 'jsonwebtoken'
import { NextApiRequest, NextApiResponse } from 'next'

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

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse,
) {
    await cors(req, res)
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    const { idToken, email, name, picture }: GoogleAuthBody = req.body ?? {}
    if (!email || !name) {
        return res.status(400).json({ error: 'Missing required fields' })
    }

    try {
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
            return res.status(500).json({ error: 'Internal server error' })
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

        return res.status(200).json(response)
    } catch (error) {
        console.error('Google auth error:', error)
        return res.status(500).json({ error: 'Internal server error' })
    }
}
