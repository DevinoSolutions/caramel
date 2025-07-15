import prisma from '@/lib/prisma'
import { NextApiRequest, NextApiResponse } from 'next'

type ApiHandler = (
    req: NextApiRequest,
    res: NextApiResponse,
) => Promise<void> | void

/**
 * withRoles(allowedRoles):
 *   - Looks up user role in DB (or trust req.user.role)
 *   - If user's role is not in allowedRoles, returns 403
 *   - Otherwise, calls the `handler` function
 */
export function withRoles(allowedRoles: string[]) {
    return function (handler: ApiHandler) {
        return async function (req: NextApiRequest, res: NextApiResponse) {
            try {
                // Ensure we have user from a previous auth middleware
                const user = (req as any).user
                if (!user || !user.id) {
                    return res
                        .status(401)
                        .json({ error: 'Unauthorized (no user from auth)' })
                }

                // Optional DB lookup for the latest user role
                const dbUser = await prisma.user.findUnique({
                    where: { id: user.id },
                    select: { role: true },
                })

                // If no user found in DB or role not in allowedRoles, forbid
                if (!dbUser || !allowedRoles.includes(dbUser.role ?? '')) {
                    return res.status(403).json({ error: 'Forbidden' })
                }

                // Attach updated role to req.user, if you like
                ;(req as any).user = { ...user, role: dbUser.role }

                return await handler(req, res)
            } catch (error) {
                // You can customize how you handle errors
                return res.status(500).json({
                    error: 'Internal Server Error',
                    message: (error as Error).message,
                })
            }
        }
    }
}
