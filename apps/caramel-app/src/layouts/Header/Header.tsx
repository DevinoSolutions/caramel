import ThemeToggle from '@/components/ThemeToggle'
import { useScrollDirection } from '@/hooks/useScrollDirection'
import { useWindowSize } from '@/hooks/useWindowSize'
import { AnimatePresence, motion } from 'framer-motion'
import Image from 'next/image'
import L from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { RiCloseFill, RiMenu3Fill, RiUser3Fill } from 'react-icons/ri'
import { useSession, signOut } from 'next-auth/react'

interface HeaderProps {
    scrollRef?: React.RefObject<HTMLElement>
}

interface NavLink {
    name: string
    url: string
}

const links: NavLink[] = [
    { name: 'Home', url: '/' },
    { name: 'Privacy', url: '/privacy' },
    { name: 'Supported Sites', url: '/supported-sites' },
]

const Link = motion.create(L)

export default function Header({ scrollRef }: HeaderProps) {
    const [isInView, setIsInView] = useState(true)
    const [isMenuOpen, setIsMenuOpen] = useState(false)
    const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false)
    const { isScrollingDown, isScrollingUp } = useScrollDirection(scrollRef)
    const { windowSize } = useWindowSize()
    const { data: session, status } = useSession()

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

    const handleSignOut = async () => {
        await signOut({ redirect: false })
        setIsProfileMenuOpen(false)
    }

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
            
            {/* Authentication Section */}
            <div className="absolute right-16 flex items-center gap-3 lg:relative lg:right-auto lg:ml-4">
                {status === 'loading' ? (
                    <div className="h-8 w-8 animate-pulse rounded-full bg-gray-300" />
                ) : session ? (
                    <div className="relative">
                        <button
                            onClick={() => setIsProfileMenuOpen(!isProfileMenuOpen)}
                            className="flex h-8 w-8 items-center justify-center rounded-full bg-caramel text-white transition hover:bg-caramel/80"
                        >
                            {session.user?.image ? (
                                <Image
                                    src={session.user.image}
                                    alt="Profile"
                                    width={32}
                                    height={32}
                                    className="h-8 w-8 rounded-full object-cover"
                                />
                            ) : (
                                <RiUser3Fill className="text-lg" />
                            )}
                        </button>
                        
                        <AnimatePresence>
                            {isProfileMenuOpen && (
                                <motion.div
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -10 }}
                                    className="absolute right-0 top-full mt-2 w-48 rounded-lg bg-white py-2 shadow-lg dark:bg-gray-800"
                                >
                                    <Link
                                        href="/profile"
                                        className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                                        onClick={() => setIsProfileMenuOpen(false)}
                                    >
                                        Profile
                                    </Link>
                                    <button
                                        onClick={() => {
                                            signOut({ callbackUrl: '/' })
                                            setIsProfileMenuOpen(false)
                                        }}
                                        className="block w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                                    >
                                        Sign Out
                                    </button>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                ) : (
                    <div className="hidden items-center gap-2 lg:flex">
                        <Link
                            href="/login"
                            className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                        >
                            Login
                        </Link>
                        <Link
                            href="/signup"
                            className="rounded-md bg-caramel px-3 py-1.5 text-sm font-medium text-white transition hover:bg-caramel/80"
                        >
                            Sign Up
                        </Link>
                    </div>
                )}
            </div>

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
                        
                        {/* Mobile Auth Buttons */}
                        <div className="mt-4 flex flex-col gap-2">
                            {session ? (
                                <>
                                    <Link
                                        href="/profile"
                                        onClick={() => setIsMenuOpen(false)}
                                        className="px-[30px] py-2.5 text-caramel inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl hover:bg-gray-100"
                                    >
                                        Profile
                                    </Link>
                                    <button
                                        onClick={() => {
                                            signOut({ callbackUrl: '/' })
                                            setIsMenuOpen(false)
                                        }}
                                        className="px-[30px] py-2.5 text-caramel inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl hover:bg-gray-100"
                                    >
                                        Sign Out
                                    </button>
                                </>
                            ) : (
                                <>
                                    <Link
                                        href="/login"
                                        onClick={() => setIsMenuOpen(false)}
                                        className="px-[30px] py-2.5 text-caramel inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl hover:bg-gray-100"
                                    >
                                        Login
                                    </Link>
                                    <Link
                                        href="/signup"
                                        onClick={() => setIsMenuOpen(false)}
                                        className="px-[30px] py-2.5 bg-caramel text-white inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl hover:bg-caramel/80"
                                    >
                                        Sign Up
                                    </Link>
                                </>
                            )}
                        </div>
                        
                        <div className="h-full" />
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.header>
    )
}
