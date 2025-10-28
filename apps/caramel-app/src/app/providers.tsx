'use client'
import { ThemeContext } from '@/lib/contexts'
import * as gtag from '@/lib/gtag'
import Hotjar from '@hotjar/browser'
import { Loader } from '@react-three/drei'
import { SessionProvider } from 'next-auth/react'
import dynamic from 'next/dynamic'
import { usePathname } from 'next/navigation'
import Script from 'next/script'
import { ReactNode, useEffect, useMemo, useState } from 'react'

const Layout = dynamic(() => import('@/layouts/Layout/Layout'), {
    ssr: false,
    loading: () => (
        <div className="flex h-full w-full flex-col items-center justify-center gap-4">
            <div className="mx-auto h-fit">
                <Loader />
            </div>
            <div>
                <p className="bg-gradient-rainbow-light font-SpaceGrotesk dark:bg-gradient-rainbow bg-clip-text text-center text-2xl font-bold text-transparent">
                    Loading...
                </p>
            </div>
        </div>
    ),
})

export default function Providers({ children }: { children: ReactNode }) {
    const pathname = usePathname()
    const [isDarkMode, setDarkMode] = useState(false)
    const pagesLayoutless = useMemo(() => ['/login', '/signup'], [])

    useEffect(() => {
        const handleRouteChange = (url: string) => gtag.pageView(url)
        handleRouteChange(pathname || '/')
    }, [pathname])

    useEffect(() => {
        if (process.env.NODE_ENV === 'production') {
            try {
                Hotjar.init(6369129, 6)
            } catch {}
        }
        const theme = localStorage.getItem('theme')
        setDarkMode(theme === 'dark')
    }, [])

    const switchTheme = () =>
        setDarkMode(prev => {
            localStorage.setItem('theme', prev ? 'light' : 'dark')
            return !prev
        })

    const content = pagesLayoutless.some(p => (pathname || '').includes(p)) ? (
        children
    ) : (
        <Layout>{children}</Layout>
    )

    return (
        <>
            <ThemeContext.Provider value={{ isDarkMode, switchTheme }}>
                <SessionProvider>{content}</SessionProvider>
            </ThemeContext.Provider>
            {/* GA */}
            <Script
                strategy="afterInteractive"
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
        </>
    )
}
