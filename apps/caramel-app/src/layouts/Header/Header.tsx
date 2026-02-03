import ThemeToggle from '@/components/ThemeToggle'
import { useScrollDirection } from '@/hooks/useScrollDirection'
import { useWindowSize } from '@/hooks/useWindowSize'
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
}

const links: NavLink[] = [
    { name: 'Home', url: '/' },
    { name: 'Coupons', url: '/coupons' },
    { name: 'Pricing', url: '/pricing' },
    { name: 'Privacy', url: '/privacy' },
    { name: 'Supported Stores', url: '/supported-stores' },
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
        await signOut()
        window.location.href = '/'
    }

    const userInitial = session?.user?.name?.charAt(0).toUpperCase() || 'U'
    const userImage = session?.user?.image || session?.user?.encodedPictureUrl

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
                className="absolute ml-6 flex h-full w-[185px] lg:static lg:ml-0"
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
                className={`dark:bg-darkerBg mx-auto flex w-full items-center justify-between rounded-[28px] bg-white px-[26px] py-[15px] shadow lg:hidden`}
            >
                <div className="ml-40"> </div>
                {/* Links in the center */}
                <div className="ml-30 flex flex-1 justify-center gap-4">
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
                </div>

                {/* Auth/Profile section */}
                <div className="flex items-center gap-3">
                    {session?.user ? (
                        <div ref={userMenuRef} className="relative">
                            <button
                                onClick={() =>
                                    setIsUserMenuOpen(!isUserMenuOpen)
                                }
                                className="bg-caramel flex h-8 w-8 items-center justify-center overflow-hidden rounded-full text-sm font-semibold text-white transition hover:scale-105"
                            >
                                {userImage ? (
                                    <Image
                                        src={userImage}
                                        alt="Profile"
                                        width={32}
                                        height={32}
                                        className="h-full w-full object-cover"
                                    />
                                ) : (
                                    userInitial
                                )}
                            </button>
                            <AnimatePresence>
                                {isUserMenuOpen && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -10 }}
                                        className="dark:bg-darkerBg absolute right-0 top-full mt-2 min-w-[150px] rounded-lg bg-white py-2 shadow-lg"
                                    >
                                        <div className="border-b px-4 py-2 text-sm text-gray-500 dark:text-gray-400">
                                            {session.user.email}
                                        </div>
                                        <Link
                                            href="/profile"
                                            onClick={() =>
                                                setIsUserMenuOpen(false)
                                            }
                                            className="text-caramel block w-full cursor-pointer px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
                                        >
                                            Profile
                                        </Link>
                                        <button
                                            onClick={handleSignOut}
                                            className="text-caramel w-full cursor-pointer px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
                                        >
                                            Sign out
                                        </button>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    ) : (
                        <>
                            <Link
                                href="/login"
                                className="text-caramel inline-flex cursor-pointer items-center justify-center gap-1 rounded-3xl px-[15px] py-2 text-sm font-medium hover:scale-105"
                            >
                                Login
                            </Link>
                            <Link
                                href="/signup"
                                className="bg-caramel inline-flex cursor-pointer items-center justify-center gap-1 rounded-3xl px-[15px] py-2 text-sm font-medium text-white transition hover:scale-105"
                            >
                                Sign Up
                            </Link>
                        </>
                    )}
                </div>
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
                        {session?.user ? (
                            <button
                                onClick={() => {
                                    setIsMenuOpen(false)
                                    handleSignOut()
                                }}
                                className="text-caramel inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl px-[30px] py-2.5"
                            >
                                Sign out
                            </button>
                        ) : (
                            <div className="flex flex-col gap-3">
                                <Link
                                    onClick={() => setIsMenuOpen(false)}
                                    href="/login"
                                    className="text-caramel border-caramel inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl border-2 px-[30px] py-2.5"
                                >
                                    Login
                                </Link>
                                <Link
                                    onClick={() => setIsMenuOpen(false)}
                                    href="/signup"
                                    className="bg-caramel inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl px-[30px] py-2.5 text-white"
                                >
                                    Sign Up
                                </Link>
                            </div>
                        )}
                        <div className="h-full" />
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.header>
    )
}
