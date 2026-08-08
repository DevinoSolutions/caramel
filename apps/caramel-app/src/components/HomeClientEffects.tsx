'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect } from 'react'

// Expired verification links land on `/?error=token_expired`; bounce them to
// the page that can actually resend the email.
//
// This lives in its own component, rendered inside <Suspense>, purely because
// useSearchParams() forces its whole route to bail out of static/server
// rendering otherwise — which is what used to leave `/` as an empty shell for
// crawlers. Keep it renderless: anything visible here would be invisible to
// crawlers too.
export default function HomeClientEffects(): null {
    const router = useRouter()
    const searchParams = useSearchParams()

    useEffect(() => {
        if (searchParams.get('error') === 'token_expired') {
            router.push('/verify?error=token_expired')
        }
    }, [searchParams, router])

    return null
}
