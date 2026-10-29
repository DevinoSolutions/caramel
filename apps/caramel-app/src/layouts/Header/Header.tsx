import ThemeToggle from '@/components/ThemeToggle'
import { useScrollDirection } from '@/hooks/useScrollDirection'
import { useWindowSize } from '@/hooks/useWindowSize'
import { useSession } from '@/lib/auth/client'
import { endClientSession } from '@/lib/auth/endClientSession'
import { DISCORD_INVITE_URL } from '@/lib/brandLinks'
import { canAdvertiseInstall } from '@/lib/surface/detectSurface'
import { useSurface } from '@/lib/surface/SurfaceProvider'
import { userInitial } from '@/lib/userInitial'
import { AnimatePresence, m } from 'framer-motion'
import Image from 'next/image'
import L from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { FaDiscord } from 'react-icons/fa'
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
    /* Advertises the extension: hidden on the `extension` surface (fleet
       growth-prompts spec §A) and stamped data-growth="install" so the CSS
       rule in globals.css hides it pre-hydration too. */
    installOnly?: boolean
}

const links: NavLink[] = [
    { name: 'Home', url: '/' },
    { name: 'Get Caramel', url: '/apps', installOnly: true },
    { name: 'Coupons', url: '/coupons' },
    { name: 'Pricing', url: '/pricing' },
    { name: 'Privacy', url: '/privacy' },
    { name: 'Stores', url: '/supported-stores', ariaLabel: 'Supported Stores' },
    { name: 'Support', url: '/support' },
]

const Link = m.create(L)

export default function Header({ scrollRef }: HeaderProps) {
    const [isInView, setIsInView] = useState(true)
    const [isMenuOpen, setIsMenuOpen] = useState(false)
    const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)
    const userMenuRef = useRef<HTMLDivElement>(null)
    const { isScrollingDown, isScrollingUp } = useScrollDirection(scrollRef)
    const { surface } = useSurface()
    const visibleLinks = links.filter(
        link => !link.installOnly || canAdvertiseInstall(surface),
    )
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
        // A failed sign-out is reported inside endClientSession; the visitor
        // is sent home either way.
        await endClientSession()
        window.location.href = '/'
    }

    const avatarLetter = session?.user ? userInitial(session.user) : 'U'

    useEffect(() => {
        if (isScrollingDown) {
            setIsInView(false)
        }
        if (isScrollingUp) {
            setIsInView(true)
        }
    }, [isScrollingDown, isScrollingUp])

    return (
        <m.header
            initial={{ y: 0, opacity: 1, scale: 1 }}
            animate={{
                y: isInView ? 0 : '-200%',
                opacity: isInView ? 1 : 0,
                scale: isInView ? 1 : 1.05,
            }}
            transition={{ duration: 0.3 }}
            className={`lg:dark:bg-darkerBg sticky top-4 z-[999] mx-auto flex w-full max-w-[min(90rem,95svw)] items-center justify-between rounded-2xl p-4 px-8 py-4 lg:rounded-[28px] lg:bg-white lg:py-3 lg:shadow`}
        >
            <Link
                href="/"
                className="absolute z-10 ml-5 flex h-full w-[185px] lg:static lg:z-auto lg:ml-0"
            >
                {/* 196×50 = the PNG's real 1830×467 aspect (3.92:1). It was
                    declared 120×120, so the browser reserved a SQUARE box
                    that collapsed to a strip when the file decoded — a
                    layout shift at the very top of every page (part of the
                    0.10 mobile CLS PageSpeed measured). Width 196 also makes
                    the optimizer's 2x variant 384px, i.e. sharp on 3x
                    phones at the ~148px CSS width it renders at. */}
                <Image
                    src="/full-logo.png"
                    alt="Caramel"
                    width={196}
                    height={50}
                    className="mb-auto mt-auto w-4/5 cursor-pointer sm:w-5/12"
                />
            </Link>
            {/* The pill holds five links, the auth block and the theme toggle in
                one row between a fixed 237px logo gutter and a 32px right pad.
                Everything is nowrap, so the gap/padding scale steps down at the
                narrower desktop widths instead of breaking onto a second line. */}
            <m.div
                className={`dark:bg-darkerBg mx-auto flex w-full items-center justify-center gap-5 rounded-[28px] bg-white py-[15px] shadow lg:hidden xl:gap-2 2xl:gap-4`}
                style={{
                    paddingLeft: 'calc(185px + 1.25rem + 32px)',
                    paddingRight: '32px',
                }}
            >
                {visibleLinks.map(link => {
                    const isActive = pathname === link.url

                    return (
                        <Link
                            key={link.name}
                            href={link.url || ''}
                            aria-label={link.ariaLabel}
                            aria-current={isActive ? 'page' : undefined}
                            data-growth={
                                link.installOnly ? 'install' : undefined
                            }
                            className={`whitespace-nowrap px-6 py-2.5 2xl:px-4 ${isActive ? 'bg-caramel text-white shadow-sm' : 'text-caramel hover:bg-caramel/10'} duration-fast ease-motion-out focus-visible:ring-caramel/60 inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl transition-[transform,background-color,color] focus-visible:outline-none focus-visible:ring-2 motion-safe:active:scale-[0.98] xl:px-3 xl:text-sm`}
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
                            className="bg-caramel ring-caramel/20 duration-fast ease-motion-out hover:ring-caramel/40 focus-visible:ring-caramel/60 flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold text-white ring-2 transition-[transform,box-shadow] focus-visible:outline-none focus-visible:ring-2 motion-safe:active:scale-[0.98]"
                        >
                            {avatarLetter}
                        </button>
                        <AnimatePresence>
                            {isUserMenuOpen && (
                                <m.div
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -10 }}
                                    className="dark:bg-darkerBg absolute right-0 top-full mt-2 min-w-[180px] rounded-xl border border-gray-100 bg-white py-2 shadow-lg dark:border-gray-800"
                                >
                                    <div className="truncate border-b border-gray-100 px-4 py-2 text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
                                        {session.user.email}
                                    </div>
                                    <Link
                                        href="/profile"
                                        onClick={() => setIsUserMenuOpen(false)}
                                        className="text-caramel hover:bg-caramel/10 focus-visible:bg-caramel/10 block w-full cursor-pointer px-4 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none"
                                    >
                                        Profile
                                    </Link>
                                    <button
                                        onClick={handleSignOut}
                                        className="text-caramel hover:bg-caramel/10 focus-visible:bg-caramel/10 w-full cursor-pointer px-4 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none"
                                    >
                                        Sign out
                                    </button>
                                </m.div>
                            )}
                        </AnimatePresence>
                    </div>
                ) : (
                    <div className="ml-2 flex items-center gap-3 xl:gap-2">
                        <Link
                            href="/login"
                            className="border-caramel text-caramel duration-fast ease-motion-out hover:bg-caramel/10 focus-visible:ring-caramel/60 inline-flex cursor-pointer items-center justify-center gap-2.5 whitespace-nowrap rounded-3xl border px-6 py-2.5 font-medium transition-[transform,background-color] focus-visible:outline-none focus-visible:ring-2 motion-safe:active:scale-[0.98] xl:px-3 xl:text-sm"
                        >
                            Login
                        </Link>
                        <Link
                            href="/signup"
                            className="bg-caramel duration-fast ease-motion-out hover:bg-caramel/90 focus-visible:ring-caramel/60 inline-flex cursor-pointer items-center justify-center gap-2.5 whitespace-nowrap rounded-3xl px-6 py-2.5 font-medium text-white shadow-sm transition-[transform,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 motion-safe:active:scale-[0.98] xl:px-3 xl:text-sm"
                        >
                            Sign Up
                        </Link>
                    </div>
                )}
                <ThemeToggle className="shrink-0" />
            </m.div>
            {/* Mobile-only companion to the in-pill toggle above: the pill is
                hidden at <=1023px, so the toggle and the menu button live here. */}
            <div className="hidden items-center gap-2 lg:ml-6 lg:flex">
                <ThemeToggle />
                <button
                    className="text-caramel hover:text-caramelLight focus-visible:ring-caramel/60 rounded-lg text-2xl transition-colors focus-visible:outline-none focus-visible:ring-2"
                    onClick={() => setIsMenuOpen(!isMenuOpen)}
                    aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
                    aria-expanded={isMenuOpen}
                >
                    {isMenuOpen ? <RiCloseFill /> : <RiMenu3Fill />}
                </button>
            </div>
            <AnimatePresence>
                {isMenuOpen && (
                    <m.div
                        initial={{ y: -50, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: -50, opacity: 0 }}
                        className="absolute left-0 top-full mt-4 flex h-[calc(90svh-100%)] w-full flex-col justify-center gap-4 overflow-auto overscroll-none rounded-xl bg-inherit py-2 !pl-4 !pr-4 pt-11 text-xs font-medium uppercase tracking-wider shadow"
                    >
                        {visibleLinks.map(link => {
                            const isActive = pathname === link.url
                            return (
                                <Link
                                    onClick={() => setIsMenuOpen(false)}
                                    key={link.name}
                                    href={link.url || ''}
                                    aria-label={link.ariaLabel}
                                    aria-current={isActive ? 'page' : undefined}
                                    data-growth={
                                        link.installOnly ? 'install' : undefined
                                    }
                                    className={`px-[30px] py-2.5 ${isActive ? 'bg-caramel text-white shadow-sm' : 'text-caramel hover:bg-caramel/10'} duration-fast focus-visible:ring-caramel/60 inline-flex cursor-pointer items-center justify-center gap-2.5 whitespace-nowrap rounded-3xl transition-colors focus-visible:outline-none focus-visible:ring-2`}
                                >
                                    {link.name}
                                </Link>
                            )
                        })}
                        {/* Menu only: the desktop pill already fills its row
                            at every width, so the Discord lives in the footer
                            there. */}
                        <a
                            href={DISCORD_INVITE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => setIsMenuOpen(false)}
                            className="text-caramel duration-fast hover:bg-caramel/10 focus-visible:ring-caramel/60 inline-flex cursor-pointer items-center justify-center gap-2.5 whitespace-nowrap rounded-3xl px-[30px] py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2"
                        >
                            <FaDiscord aria-hidden="true" className="text-sm" />
                            Join our Discord
                        </a>
                        {session?.user ? (
                            <>
                                <Link
                                    onClick={() => setIsMenuOpen(false)}
                                    href="/profile"
                                    className={`px-[30px] py-2.5 ${pathname === '/profile' ? 'bg-caramel text-white shadow-sm' : 'text-caramel hover:bg-caramel/10'} duration-fast focus-visible:ring-caramel/60 inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl transition-colors focus-visible:outline-none focus-visible:ring-2`}
                                >
                                    Profile
                                </Link>
                                <button
                                    onClick={() => {
                                        setIsMenuOpen(false)
                                        handleSignOut()
                                    }}
                                    className="text-caramel duration-fast hover:bg-caramel/10 focus-visible:ring-caramel/60 inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl px-[30px] py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2"
                                >
                                    Sign out
                                </button>
                            </>
                        ) : (
                            <>
                                <Link
                                    onClick={() => setIsMenuOpen(false)}
                                    href="/login"
                                    className="border-caramel text-caramel duration-fast hover:bg-caramel/10 focus-visible:ring-caramel/60 inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl border px-[30px] py-2.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2"
                                >
                                    Login
                                </Link>
                                <Link
                                    onClick={() => setIsMenuOpen(false)}
                                    href="/signup"
                                    className="bg-caramel duration-fast hover:bg-caramel/90 focus-visible:ring-caramel/60 inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl px-[30px] py-2.5 font-medium text-white shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2"
                                >
                                    Sign Up
                                </Link>
                            </>
                        )}
                        <div className="h-full" />
                    </m.div>
                )}
            </AnimatePresence>
        </m.header>
    )
}
