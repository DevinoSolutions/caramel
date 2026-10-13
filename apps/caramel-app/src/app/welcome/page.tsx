import { parseWelcomeParams } from '@/lib/extensionInstall'
import type { Metadata } from 'next'
import WelcomePageClient from './WelcomePageClient'

// The page the extension opens once, right after install (background.js
// `runtime.onInstalled`, reason 'install'). It exists to say thanks and show
// where the button went, and, as a side effect, to attribute the install
// (WelcomePageClient -> recordExtensionInstalled).
//
// Deliberately NOT discoverable: noindex here, Disallow in robots.ts, and not
// in sitemap.ts. It is a one-time post-install screen, not content.
export const metadata: Metadata = {
    title: 'Welcome to Caramel',
    description: 'Caramel is installed. Pin it and start saving.',
    robots: { index: false, follow: false },
}

// The install facts are read HERE, on the server, and handed down as props
// (same reason as /verify: useSearchParams in the client component would opt
// the whole subtree out of server rendering and leave a placeholder in the
// HTML). A missing or malformed query string yields `install: null`: the page
// still renders and records nothing.
export default async function WelcomePage({
    searchParams,
}: {
    searchParams: Promise<{
        src?: string | string[]
        store?: string | string[]
        v?: string | string[]
        iid?: string | string[]
    }>
}) {
    const install = parseWelcomeParams(await searchParams)
    return <WelcomePageClient install={install} />
}
