import Footer from '@/layouts/Footer/Footer'
import Header from '@/layouts/Header/Header'
import { ThemeContext } from '@/lib/contexts'
import { useContext, useRef } from 'react'

interface LayoutProps {
    children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
    const { isDarkMode } = useContext(ThemeContext)
    const ref = useRef<HTMLDivElement>(null)
    return (
        // <html> is the AUTHORITATIVE theme marker now (stamped pre-paint by
        // the script in app/layout.tsx, kept in sync by switchTheme): it is what
        // satisfies every `dark:` variant below and what paints the page
        // background via globals.css. This wrapper's `dark`/`light` is a
        // secondary scope only — the server can't know the stored theme, so it
        // emits `light`, and so does the first client render (providers.tsx
        // adopts the stored theme in an effect), which is why no suppression is
        // needed here. Don't reintroduce a background: it would repaint the
        // whole viewport light until hydration, the flash this all exists to
        // kill.
        // overflow-x-CLIP, not -hidden: `hidden` creates a scroll container,
        // which silently becomes the containing block for every
        // `position: sticky` inside it — the site header (sticky top-4)
        // scrolled away on every page (measured top:-1184 on /privacy,
        // 2026-08-10). `clip` cuts horizontal overflow identically but
        // creates NO scroll container, so sticky works against the viewport
        // again. Same one-char class swap Tailwind ships for exactly this.
        <div
            ref={ref}
            className={`flex min-h-screen flex-col overflow-x-clip scroll-smooth ${
                isDarkMode ? 'dark' : 'light'
            } font-Roboto`}
        >
            <Header scrollRef={ref} />
            <div className="flex-1">{children}</div>
            <Footer />
        </div>
    )
}
