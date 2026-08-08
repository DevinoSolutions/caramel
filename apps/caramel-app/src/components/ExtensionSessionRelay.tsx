'use client'

import { useSession } from '@/lib/auth/client'
import { useEffect, useRef } from 'react'

// Website→extension sign-in relay (page side). The Caramel extension's
// content script announces itself with a same-origin window message when
// it has no stored session; if the visitor is signed in here, we mint an
// extension token (POST /api/extension/session, cookie-authenticated) and
// post it back. The content script only accepts the token message from
// its own origin allowlist, and this component only reacts to messages
// from this page's own origin — a third-party iframe/script can neither
// trigger the mint nor intercept the postMessage (targetOrigin is ours).
export default function ExtensionSessionRelay() {
    const { data: session } = useSession()
    const signedIn = !!session?.user
    // Refs, not state: a hello arriving before the session query resolves
    // must still trigger the relay once it does, without re-rendering.
    const helloSeen = useRef(false)
    const mintInFlight = useRef(false)
    const minted = useRef(false)

    useEffect(() => {
        const relay = async () => {
            if (minted.current || mintInFlight.current) return
            mintInFlight.current = true
            try {
                const res = await fetch('/api/extension/session', {
                    method: 'POST',
                })
                if (!res.ok) return
                const data: {
                    token?: string
                    username?: string | null
                    image?: string | null
                } = await res.json()
                if (!data.token) return
                window.postMessage(
                    {
                        token: data.token,
                        username: data.username ?? null,
                        image: data.image ?? null,
                    },
                    window.location.origin,
                )
                minted.current = true
            } catch (err) {
                // Non-blocking nicety — never break the page over it, but
                // don't fail silently either.
                console.error('extension session relay failed', err)
            } finally {
                mintInFlight.current = false
            }
        }

        const onMessage = (ev: MessageEvent) => {
            if (ev.origin !== window.location.origin) return
            const type = (ev.data as { type?: unknown } | null)?.type
            if (type !== 'caramel-ext-hello') return
            helloSeen.current = true
            if (signedIn) void relay()
        }

        window.addEventListener('message', onMessage)
        // The hello can predate the session query resolving (or a login on
        // this very page) — replay it once we know the user is signed in.
        if (helloSeen.current && signedIn) void relay()
        return () => window.removeEventListener('message', onMessage)
    }, [signedIn])

    return null
}
