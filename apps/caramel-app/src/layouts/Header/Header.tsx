import ThemeToggle from '@/components/ThemeToggle'
import { useScrollDirection } from '@/hooks/useScrollDirection'
import { useWindowSize } from '@/hooks/useWindowSize'
import { resetPosthogIdentity } from '@/lib/analytics/identity'
import { signOut, useSession } from '@/lib/auth/client'
import { AnimatePresence, motion } from 'framer-motion'
import Image from 'next/image'
import L from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { RiCloseFill, RiMenu3Fill } from 'react-icons/ri'

interface HeaderProps {
    scrollRef?: React.RefObject<HTMLElement | HTMLDivElement | null>
}

interface NavLink {
    name: string
    url: string
    /* Full accessible name where the visible label is abbreviated to keep the
       nav pill on one line. */
    ariaLabel?: string
}

const links: NavLink[] = [
    { name: 'Home', url: '/' },
    { name: 'Coupons', url: '/coupons' },
    { name: 'Pricing', url: '/pricing' },
    { name: 'Privacy', url: '/privacy' },
    { name: 'Stores', url: '/supported-stores', ariaLabel: 'Supported Stores' },
    { name: 'Support', url: '/support' },
]

const Link = motion.create(L)

export default function Header({ scrollRef }: HeaderProps) {
    const [isInView, setIsInView] = useState(true)
    const [isMenuOpen, setIsMenuOpen] = useState(false)
    const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)
    const userMenuRef = useRef<HTMLDivElement>(null)
    const { isScrollingDown, isScrollingUp } = useScrollDirection(scrollRef)
    const { windowSize } = useWindowSize()
    const { data: session } = useSession()

    useEffect(() => {}, [windowSize])
    const pathname = usePathname()

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (
                userMenuRef.current &&
                !userMenuRef.current.contains(event.target as Node)
            ) {
                setIsUserMenuOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () =>
            document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const handleSignOut = async () => {
        // Clear the PostHog identity BEFORE the session goes away so the reset
        // isn't attributed to the logged-in person.
        resetPosthogIdentity()
        await signOut()
        window.location.href = '/'
    }

    const userInitial = session?.user?.name?.charAt(0).toUpperCase() || 'U'

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
            className={`sticky top-4 z-[999] mx-auto flex w-full max-w-[min(90rem,95svw)] items-center justify-between rounded-2xl p-4 px-8 py-4 lg:rounded-[28px] lg:bg-white lg:py-3 lg:shadow lg:dark:bg-darkerBg`}
        >
            <Link
                href="/"
                className="absolute z-10 ml-5 flex h-full w-[185px] lg:static lg:z-auto lg:ml-0"
            >
                <Image
                    src="/full-logo.png"
                    alt="logo"
                    height={120}
                    width={120}
                    className="mb-auto mt-auto w-4/5 cursor-pointer sm:w-5/12"
                />
            </Link>
            {/* The pill holds five links, the auth block and the theme toggle in
                one row between a fixed 237px logo gutter and a 32px right pad.
                Everything is nowrap, so the gap/padding scale steps down at the
                narrower desktop widths instead of breaking onto a second line. */}
            <motion.div
                className={`mx-auto flex w-full items-center justify-center gap-5 rounded-[28px] bg-white py-[15px] shadow dark:bg-darkerBg 2xl:gap-4 xl:gap-2 lg:hidden`}
                style={{
                    paddingLeft: 'calc(185px + 1.25rem + 32px)',
                    paddingRight: '32px',
                }}
            >
                {links.map(link => {
                    const isActive = pathname === link.url

                    return (
                        <Link
                            key={link.name}
                            href={link.url || ''}
                            aria-label={link.ariaLabel}
                            aria-current={isActive ? 'page' : undefined}
                            className={`whitespace-nowrap px-6 py-2.5 hover:scale-105 2xl:px-4 ${isActive ? 'bg-caramel text-white shadow-sm' : 'text-caramel hover:bg-caramel/10'} inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/60 xl:px-3 xl:text-sm`}
                        >
                            {link.name}
                        </Link>
                    )
                })}
                {session?.user ? (
                    <div ref={userMenuRef} className="relative ml-2">
                        <button
                            onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                            aria-haspopup="menu"
                            aria-expanded={isUserMenuOpen}
                            aria-label="Account menu"
                            className="flex h-8 w-8 items-center justify-center rounded-full bg-caramel text-sm font-semibold text-white ring-2 ring-caramel/20 transition hover:scale-105 hover:ring-caramel/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/60"
                        >
                            {userInitial}
                        </button>
                        <AnimatePresence>
                            {isUserMenuOpen && (
                                <motion.div
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -10 }}
                                    className="absolute right-0 top-full mt-2 min-w-[180px] rounded-xl border border-gray-100 bg-white py-2 shadow-lg dark:border-gray-800 dark:bg-darkerBg"
                                >
                                    <div className="truncate border-b border-gray-100 px-4 py-2 text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
                                        {session.user.email}
                                    </div>
                                    <Link
                                        href="/profile"
                                        onClick={() => setIsUserMenuOpen(false)}
                                        className="block w-full cursor-pointer px-4 py-2 text-left text-sm font-medium text-caramel transition-colors hover:bg-caramel/10 focus-visible:bg-caramel/10 focus-visible:outline-none"
                                    >
                                        Profile
                                    </Link>
                                    <button
                                        onClick={handleSignOut}
                                        className="w-full cursor-pointer px-4 py-2 text-left text-sm font-medium text-caramel transition-colors hover:bg-caramel/10 focus-visible:bg-caramel/10 focus-visible:outline-none"
                                    >
                                        Sign out
                                    </button>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                ) : (
                    <div className="ml-2 flex items-center gap-3 xl:gap-2">
                        <Link
                            href="/login"
                            className="inline-flex cursor-pointer items-center justify-center gap-2.5 whitespace-nowrap rounded-3xl border border-caramel px-6 py-2.5 font-medium text-caramel transition hover:scale-105 hover:bg-caramel/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/60 xl:px-3 xl:text-sm"
                        >
                            Login
                        </Link>
                        <Link
                            href="/signup"
                            className="inline-flex cursor-pointer items-center justify-center gap-2.5 whitespace-nowrap rounded-3xl bg-caramel px-6 py-2.5 font-medium text-white shadow-sm transition hover:scale-105 hover:bg-caramel/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/60 focus-visible:ring-offset-2 xl:px-3 xl:text-sm"
                        >
                            Sign Up
                        </Link>
                    </div>
                )}
                <ThemeToggle className="shrink-0" />
            </motion.div>
            {/* Mobile-only companion to the in-pill toggle above: the pill is
                hidden at <=1023px, so the toggle and the menu button live here. */}
            <div className="hidden items-center gap-2 lg:ml-6 lg:flex">
                <ThemeToggle />
                <button
                    className="rounded-lg text-2xl text-caramel transition-colors hover:text-caramelLight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/60"
                    onClick={() => setIsMenuOpen(!isMenuOpen)}
                    aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
                    aria-expanded={isMenuOpen}
                >
                    {isMenuOpen ? <RiCloseFill /> : <RiMenu3Fill />}
                </button>
            </div>
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
                                    aria-label={link.ariaLabel}
                                    aria-current={isActive ? 'page' : undefined}
                                    className={`px-[30px] py-2.5 ${isActive ? 'bg-caramel text-white shadow-sm' : 'text-caramel hover:bg-caramel/10'} inline-flex cursor-pointer items-center justify-center gap-2.5 whitespace-nowrap rounded-3xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/60`}
                                >
                                    {link.name}
                                </Link>
                            )
                        })}
                        {session?.user ? (
                            <>
                                <Link
                                    onClick={() => setIsMenuOpen(false)}
                                    href="/profile"
                                    className={`px-[30px] py-2.5 ${pathname === '/profile' ? 'bg-caramel text-white shadow-sm' : 'text-caramel hover:bg-caramel/10'} inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/60`}
                                >
                                    Profile
                                </Link>
                                <button
                                    onClick={() => {
                                        setIsMenuOpen(false)
                                        handleSignOut()
                                    }}
                                    className="inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl px-[30px] py-2.5 text-caramel transition hover:bg-caramel/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/60"
                                >
                                    Sign out
                                </button>
                            </>
                        ) : (
                            <>
                                <Link
                                    onClick={() => setIsMenuOpen(false)}
                                    href="/login"
                                    className="inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl border border-caramel px-[30px] py-2.5 font-medium text-caramel transition hover:bg-caramel/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/60"
                                >
                                    Login
                                </Link>
                                <Link
                                    onClick={() => setIsMenuOpen(false)}
                                    href="/signup"
                                    className="inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl bg-caramel px-[30px] py-2.5 font-medium text-white shadow-sm transition hover:bg-caramel/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/60"
                                >
                                    Sign Up
                                </Link>
                            </>
                        )}
                        <div className="h-full" />
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.header>
    )
}
