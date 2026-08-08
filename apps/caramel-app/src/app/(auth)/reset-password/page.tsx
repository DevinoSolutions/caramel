import type { Metadata } from 'next'
import ResetPasswordPageClient from './ResetPasswordPageClient'

const title = 'Choose a new password | Caramel'
const description = 'Set a new password for your Caramel account.'

export const metadata: Metadata = {
    title,
    description,
    /* noindex is not optional here: the URL carries a single-use reset token as
     * a query parameter, and an indexed copy would publish it. `nofollow` too —
     * there is nothing on this page worth crawling. */
    robots: { index: false, follow: false },
}

/* The token arrives as a query parameter on the emailed link and is read on the
 * server, like /login and /verify — a client-side read would leave the page
 * unable to distinguish "no token" from "not hydrated yet" and flash the
 * expired-link screen at every visitor before settling. */
export default async function ResetPassword({
    searchParams,
}: {
    searchParams: Promise<{ token?: string; error?: string }>
}) {
    const { token, error } = await searchParams
    return <ResetPasswordPageClient token={token} error={error} />
}
