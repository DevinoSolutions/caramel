import ThemeToggle from '@/components/ThemeToggle'
import { useScrollDirection } from '@/hooks/useScrollDirection'
import { useWindowSize } from '@/hooks/useWindowSize'
import { AnimatePresence, motion } from 'framer-motion'
import Image from 'next/image'
import L from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { RiCloseFill, RiMenu3Fill } from 'react-icons/ri'

interface HeaderProps {
    scrollRef?: React.RefObject<HTMLElement | HTMLDivElement | null>
}

interface NavLink {
    name: string
    url: string
}

const links: NavLink[] = [
    { name: 'Home', url: '/' },
    { name: 'Privacy', url: '/privacy' },
    { name: 'Supported Sites', url: '/supported-sites' },
    { name: 'Coupons', url: '/coupons' },
]

const Link = motion.create(L)

export default function Header({ scrollRef }: HeaderProps) {
    const [isInView, setIsInView] = useState(true)
    const [isMenuOpen, setIsMenuOpen] = useState(false)
    const { isScrollingDown, isScrollingUp } = useScrollDirection(scrollRef)
    const { windowSize } = useWindowSize()

    useEffect(() => {}, [windowSize])
    const pathname = usePathname()

    useEffect(() => {
        if (isScrollingDown) {
            setIsInView(false)
        }
        if (isScrollingUp) {
            setIsInView(true)
        }
    }, [isScrollingDown, isScrollingUp])

    return (
        <motion.header
            initial={{ y: 0, opacity: 1, scale: 1 }}
            animate={{
                y: isInView ? 0 : '-200%',
                opacity: isInView ? 1 : 0,
                scale: isInView ? 1 : 1.05,
            }}
            transition={{ duration: 0.3 }}
            className={`lg:dark:bg-darkerBg sticky top-4 z-[999] mx-auto flex w-full max-w-[min(75rem,93svw)] items-center justify-between rounded-2xl p-4 px-8 py-4 lg:rounded-[28px] lg:bg-white lg:py-3 lg:shadow`}
        >
            <Link
                href="/"
                className="absolute ml-5 flex h-full w-[185px] lg:static lg:ml-0"
            >
                <Image
                    src="/full-logo.png"
                    alt="logo"
                    height={120}
                    width={120}
                    className="mb-auto mt-auto w-4/5 cursor-pointer sm:w-5/12"
                />
            </Link>
            <motion.div
                className={`dark:bg-darkerBg mx-auto flex w-full items-start justify-center gap-6 rounded-[28px] bg-white px-[26px] py-[15px] shadow lg:hidden`}
            >
                {links.map(link => {
                    const isActive = pathname === link.url

                    return (
                        <Link
                            key={link.name}
                            href={link.url || ''}
                            className={`px-[30px] py-2.5 hover:scale-105 ${isActive ? 'bg-caramel text-white' : 'text-caramel'} inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl`}
                        >
                            {link.name}
                        </Link>
                    )
                })}
            </motion.div>
            <ThemeToggle className="absolute -right-4 lg:relative lg:right-auto lg:ml-auto" />
            <button
                className="text-caramel ml-3 hidden text-2xl lg:block"
                onClick={() => setIsMenuOpen(!isMenuOpen)}
            >
                {isMenuOpen ? <RiCloseFill /> : <RiMenu3Fill />}
            </button>
            <AnimatePresence>
                {isMenuOpen && (
                    <motion.div
                        initial={{ y: -50, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: -50, opacity: 0 }}
                        className="absolute left-0 top-full mt-4 flex h-[calc(90svh-100%)] w-full flex-col justify-center gap-4 overflow-auto overscroll-none rounded-xl bg-inherit py-2 !pl-4 !pr-4 pt-11 text-xs font-medium uppercase tracking-wider shadow"
                    >
                        {links.map(link => {
                            const isActive = pathname === link.url
                            return (
                                <Link
                                    onClick={() => setIsMenuOpen(false)}
                                    key={link.name}
                                    href={link.url || ''}
                                    className={`px-[30px] py-2.5 ${isActive ? 'bg-caramel text-white' : 'text-caramel'} inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl`}
                                >
                                    {link.name}
                                </Link>
                            )
                        })}
                        <div className="h-full" />
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.header>
    )
}
