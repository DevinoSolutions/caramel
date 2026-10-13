'use client'

import { recordExtensionInstalled } from '@/lib/analytics/extensionInstalled'
import {
    CHROME_WEB_STORE_URL,
    EDGE_ADDONS_URL,
    FIREFOX_ADDONS_URL,
    SAFARI_APP_STORE_URL,
} from '@/lib/brandLinks'
import type { ExtensionStore, WelcomeParams } from '@/lib/extensionInstall'
import Link from 'next/link'
import { useEffect } from 'react'

// One tip per browser: where the pin lives differs, and the pin is the whole
// point of this page (an unpinned extension is one the user forgets).
const PIN_TIPS: Record<ExtensionStore, string> = {
    chrome: 'Click the puzzle-piece icon next to the address bar, then the pin beside Caramel.',
    edge: 'Click the puzzle-piece icon next to the address bar, then the eye icon beside Caramel to keep it showing.',
    firefox:
        'Click the puzzle-piece icon in the toolbar, open the menu beside Caramel and choose Pin to Toolbar.',
    safari: 'Open Safari Settings, go to Extensions, tick Caramel and allow it on the sites you shop.',
}

const OTHER_BROWSERS: ReadonlyArray<{
    store: ExtensionStore
    label: string
    href: string
}> = [
    { store: 'chrome', label: 'Chrome', href: CHROME_WEB_STORE_URL },
    { store: 'firefox', label: 'Firefox', href: FIREFOX_ADDONS_URL },
    { store: 'edge', label: 'Edge', href: EDGE_ADDONS_URL },
    { store: 'safari', label: 'Safari', href: SAFARI_APP_STORE_URL },
]

export default function WelcomePageClient({
    install,
}: {
    install: WelcomeParams | null
}) {
    // Primitive deps: the `install` object is a fresh reference on each render
    // of the server component, and the effect must run once per install id.
    const iid = install?.iid
    const store = install?.store
    const extensionVersion = install?.extensionVersion

    useEffect(() => {
        if (!iid || !store || !extensionVersion) return
        // recordExtensionInstalled reports its own failures (console + Sentry)
        // and never rejects: a failed attribution must not break the page.
        void recordExtensionInstalled({ iid, store, extensionVersion })
    }, [iid, store, extensionVersion])

    const pinTip = store ? PIN_TIPS[store] : PIN_TIPS.chrome

    return (
        <main className="mx-auto flex min-h-[70vh] w-full max-w-2xl flex-col justify-center gap-8 px-6 py-24 text-center">
            <div>
                <h1 className="text-4xl font-bold tracking-tight text-gray-900 dark:text-white sm:text-3xl">
                    Caramel is installed. Thank you!
                </h1>
                <p className="mt-3 text-lg text-gray-600 dark:text-gray-400">
                    Shop as usual. When there is a coupon that works, Caramel
                    will find it at checkout.
                </p>
            </div>

            <section
                aria-labelledby="pin-heading"
                className="rounded-3xl border border-caramel/20 bg-white/80 p-6 text-left shadow-sm dark:border-caramel/30 dark:bg-darkSurface"
            >
                <h2
                    id="pin-heading"
                    className="text-lg font-semibold text-gray-900 dark:text-white"
                >
                    Tip: pin Caramel so it is always one click away
                </h2>
                <p className="mt-2 text-gray-700 dark:text-gray-300">
                    {pinTip}
                </p>
            </section>

            <section
                aria-labelledby="account-heading"
                className="text-gray-700 dark:text-gray-300"
            >
                <h2
                    id="account-heading"
                    className="text-lg font-semibold text-gray-900 dark:text-white"
                >
                    Optional: save your finds with an account
                </h2>
                <p className="mt-2">
                    Caramel works without one. A free account keeps your
                    favorites and savings in sync.
                </p>
                <div className="mt-4 flex justify-center gap-3">
                    <Link
                        href="/signup"
                        className="rounded-full bg-caramel px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2"
                    >
                        Create an account
                    </Link>
                    <Link
                        href="/login"
                        className="rounded-full border border-gray-300 px-5 py-2.5 text-sm font-semibold text-gray-800 transition hover:border-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:border-gray-700 dark:text-gray-200"
                    >
                        Sign in
                    </Link>
                </div>
            </section>

            <section
                aria-labelledby="other-browsers-heading"
                className="text-sm text-gray-600 dark:text-gray-400"
            >
                <h2 id="other-browsers-heading" className="font-semibold">
                    Use another browser too?
                </h2>
                <ul className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1">
                    {OTHER_BROWSERS.filter(
                        browser => browser.store !== store,
                    ).map(browser => (
                        <li key={browser.store}>
                            <a
                                href={browser.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-semibold text-caramel underline-offset-2 hover:underline"
                            >
                                Caramel for {browser.label}
                            </a>
                        </li>
                    ))}
                </ul>
            </section>
        </main>
    )
}
