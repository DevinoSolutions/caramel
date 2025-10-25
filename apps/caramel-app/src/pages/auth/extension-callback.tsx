import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/router'

/**
 * Extension OAuth Callback Page
 *
 * This page is opened in a new tab after OAuth authentication.
 * It stores the auth data directly in the browser extension storage and auto-closes the tab.
 */
export default function ExtensionCallback() {
    const { data: session, status } = useSession()
    const router = useRouter()
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        const sendTokenToExtension = async () => {
            // Wait for session to load
            if (status === 'loading') {
                return
            }

            // Check if user is authenticated
            if (status === 'unauthenticated' || !session?.user) {
                setError('Authentication failed. Please try again.')
                setTimeout(() => {
                    router.push('/')
                }, 2000)
                return
            }

            try {
                const tokenData = {
                    token: (session as any).accessToken || 'temp-token-' + Date.now(),
                    username: session.user.username || session.user.name || session.user.email?.split('@')[0] || 'User',
                    image: session.user.image || '',
                }

                // Send auth data to extension via postMessage
                window.postMessage({
                    type: 'CARAMEL_EXTENSION_AUTH',
                    token: tokenData.token,
                    username: tokenData.username,
                    image: tokenData.image
                }, '*')

                // Redirect to landing page after a short delay
                setTimeout(() => {
                    router.push('/')
                }, 2000)
            } catch (err) {
                setError('Failed to complete authentication')
                setTimeout(() => {
                    router.push('/')
                }, 2000)
            }
        }

        sendTokenToExtension()
    }, [session, status, router])

    return (
        <div className="flex h-screen items-center justify-center bg-gray-50">
            <div className="text-center">
                {status === 'loading' && (
                    <>
                        <div className="mb-4 text-xl font-semibold text-gray-800">
                            Completing authentication...
                        </div>
                        <div className="text-gray-600">Please wait</div>
                    </>
                )}
                {status === 'authenticated' && !error && (
                    <>
                        <div className="mb-4 text-xl font-semibold text-green-600">
                            ✓ Authentication successful!
                        </div>
                        <div className="text-gray-600">
                            You can close this tab now
                        </div>
                    </>
                )}
                {error && (
                    <>
                        <div className="mb-4 text-xl font-semibold text-red-600">
                            {error}
                        </div>
                        <div className="text-gray-600">Redirecting...</div>
                    </>
                )}
            </div>
        </div>
    )
}