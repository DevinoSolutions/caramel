import { authOptions } from '@/lib/authOptions'
import { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth/next'

type ApiHandler = (
    req: NextApiRequest,
    res: NextApiResponse,
) => Promise<void> | void

/**
 * A higher-order function (HOF) that ensures a user is logged in.
 *
 * Usage:
 * export default withAuth(async function handler(req, res) { ... })
 */
export function withAuth(handler: ApiHandler) {
    return async function (req: NextApiRequest, res: NextApiResponse) {
        try {
            const session = await getServerSession(req, res, authOptions)

            if (!session?.user?.id) {
                return res
                    .status(401)
                    .json({ status: 'error', message: 'Unauthorized' })
            }

            // Add session and user to request object
            ;(req as any).session = session
            ;(req as any).user = session.user

            // Proceed to the actual request handler
            return handler(req, res)
        } catch (error) {
            // In case something goes wrong during session retrieval
            return res.status(500).json({
                status: 'error',
                message: (error as Error).message || 'Server Error',
            })
        }
    }
}
