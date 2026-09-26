'use client'
import ExtensionSessionRelay from '@/components/ExtensionSessionRelay'
import GrowthPromptHost from '@/components/growth/GrowthPromptHost'
import SupportDialog from '@/components/support/SupportDialog'
import Layout from '@/layouts/Layout/Layout'
import PostHogClientProvider from '@/lib/analytics/PostHogClientProvider'
import { runAfterLoadWhenIdle } from '@/lib/analytics/runAfterLoadWhenIdle'
import { ThemeContext } from '@/lib/contexts'
import * as gtag from '@/lib/gtag'
import { SurfaceProvider } from '@/lib/surface/SurfaceProvider'
import Hotjar from '@hotjar/browser'
import * as Sentry from '@sentry/nextjs'
import { usePathname } from 'next/navigation'
import Script from 'next/script'
import { ReactNode, useEffect, useMemo, useState } from 'react'
import { Toaster } from 'sonner'

// Layout is imported STATICALLY on purpose. It used to be a
// `next/dynamic(..., { ssr: false })` wrapper, which meant crawlers received an
// empty shell for every page — the site's worst SEO defect. The only thing
// ssr:false actually bought was hiding the theme flash: with the tree client-
// only, the neutral loading spinner covered the window between first paint and
// the localStorage read below. That is now solved properly by the
// pre-hydration script in app/layout.tsx, so the tree can server-render.

export default function Providers({ children }: { children: ReactNode }) {
    const pathname = usePathname()
    // The stored theme is client-only knowledge, so this starts at the SERVER's
    // answer (light) and adopts the real one in an effect. Reading the
    // pre-hydration script's <html> class during the first client render instead
    // made that render disagree with the server HTML everywhere isDarkMode
    // drives an attribute — the store logos in SupportedSection, react-select's
    // emotion classes on /coupons, the toggle's aria-label — and React does not
    // patch mismatched attributes up, so a returning dark-mode visitor could be
    // left holding the server's light values indefinitely.
    // Nothing flashes: <html class="dark"> is already stamped pre-paint, and it
    // is what satisfies every Tailwind `dark:` variant and paints the page
    // background.
    const [isDarkMode, setDarkMode] = useState(false)
    /* Must list EVERY route in the src/app/(auth) group.
     *
     * The (auth) group has its own full-screen shell (brand panel, background,
     * theme toggle), and anything missing from this list gets the marketing
     * Layout wrapped around that shell as well — two headers, two theme
     * toggles, a footer under the sign-in form. That is exactly what
     * /forgot-password and /reset-password shipped as until this line was
     * updated, because the list is matched by hand rather than derived from the
     * route group. tests/unit/auth-routes-layoutless.test.ts walks the (auth)
     * directory and fails when a route is added without being listed here. */
    const pagesLayoutless = useMemo(
        () => [
            '/login',
            '/signup',
            '/verify',
            '/forgot-password',
            '/reset-password',
        ],
        [],
    )

    useEffect(() => {
        setDarkMode(document.documentElement.classList.contains('dark'))
        // Effects run only after React has committed the hydrated tree, so this
        // attribute is the one honest "hydration is done" signal on the page.
        // The visual-regression specs gate on it: Argos rewrites img loading/
        // decoding and stamps data-argos-* before capturing, and doing that
        // mid-hydration makes React report attribute mismatches it will not
        // patch up. <html> already carries suppressHydrationWarning for the
        // pre-paint theme script, so writing here is safe.
        document.documentElement.dataset.hydrated = 'true'
    }, [])

    useEffect(() => {
        const handleRouteChange = (url: string) => gtag.pageView(url)
        handleRouteChange(pathname || '/')
    }, [pathname])

    // Hotjar waits for the load event + an idle main thread
    // (lib/analytics/runAfterLoadWhenIdle.ts has the measurement).
    useEffect(() => {
        if (process.env.NODE_ENV !== 'production') return
        return runAfterLoadWhenIdle(() => {
            try {
                Hotjar.init(6369129, 6)
            } catch (error) {
                // Analytics must never break the page, but must not fail
                // silently either.
                console.error('[hotjar] init failed', error)
                Sentry.captureException(error, {
                    tags: { operation: 'hotjar_init' },
                })
            }
        })
    }, [])

    const switchTheme = () => {
        const next = !isDarkMode
        setDarkMode(next)
        localStorage.setItem('theme', next ? 'dark' : 'light')
        // Keep <html> authoritative: globals.css paints the page background off
        // `html.dark`, and the next full load reads it back before hydration.
        const classes = document.documentElement.classList
        classes.toggle('dark', next)
        classes.toggle('light', !next)
    }

    const content = pagesLayoutless.some(p => (pathname || '').includes(p)) ? (
        children
    ) : (
        <Layout>{children}</Layout>
    )

    return (
        <PostHogClientProvider>
            <SurfaceProvider>
                <ThemeContext.Provider value={{ isDarkMode, switchTheme }}>
                    {content}
                </ThemeContext.Provider>
                {/* The ONE growth-prompt slot on the site (lib/prompts). It
                    must sit inside SurfaceProvider: it never prompts until
                    the surface has resolved. */}
                <GrowthPromptHost />
            </SurfaceProvider>
            <ExtensionSessionRelay />
            <Toaster
                position="bottom-right"
                toastOptions={{
                    style: {
                        background: '#ea6925',
                        color: '#ffffff',
                        border: 'none',
                    },
                }}
            />
            {/* App-level support modal — opened via the module-level registry
                (promptSupportOnFailure) without prop drilling. */}
            <SupportDialog />
            {/* GA. gtag.js (173 KB) loads after the load event, when the
                main thread is idle: fetched early it competed with the app's
                own JS on slow connections. The inline init below still runs
                right after hydration, so window.gtag exists for pageView()
                and every command queues in dataLayer until gtag.js loads. */}
            <Script
                strategy="lazyOnload"
                src={`https://www.googletagmanager.com/gtag/js?id=${gtag.GA_TRACKING_ID}`}
            />
            <Script id="gtag-init" strategy="afterInteractive">
                {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${gtag.GA_TRACKING_ID}');
        `}
            </Script>
        </PostHogClientProvider>
    )
}
