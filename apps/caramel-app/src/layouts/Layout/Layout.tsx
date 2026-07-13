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
        <div
            ref={ref}
            className={`flex min-h-screen flex-col overflow-x-hidden scroll-smooth ${
                isDarkMode ? 'dark bg-darkBg' : 'light bg-gray-50'
            } font-Roboto`}
        >
            <Header scrollRef={ref} />
            <div className="flex-1">{children}</div>
            <Footer />
        </div>
    )
}
