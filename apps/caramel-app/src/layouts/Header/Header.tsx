import ThemeToggle from '@/components/ThemeToggle'
import { useScrollDirection } from '@/hooks/useScrollDirection'
import { useWindowSize } from '@/hooks/useWindowSize'
import { AnimatePresence, motion } from 'framer-motion'
import Image from 'next/image'
import L from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { RiCloseFill, RiMenu3Fill, RiUserLine, RiLogoutBoxLine } from 'react-icons/ri'
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
            <div className="flex items-center gap-4">
                <ThemeToggle className="absolute -right-4 lg:relative lg:right-auto lg:ml-auto" />
                
                {/* Authentication Section */}
                {status === 'loading' ? (
                    <div className="hidden lg:block w-8 h-8 animate-pulse bg-gray-300 rounded-full"></div>
                ) : session ? (
                    /* Profile Menu */
                    <div className="relative hidden lg:block">
                        <button
                            onClick={() => setIsProfileMenuOpen(!isProfileMenuOpen)}
                            className="flex items-center gap-2 text-caramel hover:text-orange-600 transition"
                        >
                            {session.user?.image ? (
                                <Image
                                    src={session.user.image}
                                    alt="Profile"
                                    width={32}
                                    height={32}
                                    className="rounded-full"
                                />
                            ) : (
                                <div className="w-8 h-8 bg-caramel rounded-full flex items-center justify-center">
                                    <RiUserLine className="text-white text-sm" />
                                </div>
                            )}
                            <span className="text-sm font-medium">
                                {session.user?.name || 'User'}
                            </span>
                        </button>
                        
                        <AnimatePresence>
                            {isProfileMenuOpen && (
                                <motion.div
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -10 }}
                                    className="absolute right-0 top-full mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-2 z-50"
                                >
                                    <Link
                                        href="/profile"
                                        className="flex items-center gap-2 px-4 py-2 text-gray-700 hover:bg-gray-100 transition"
                                        onClick={() => setIsProfileMenuOpen(false)}
                                    >
                                        <RiUserLine className="text-sm" />
                                        Profile
                                    </Link>
                                    <button
                                        onClick={handleSignOut}
                                        className="flex items-center gap-2 px-4 py-2 text-gray-700 hover:bg-gray-100 transition w-full text-left"
                                    >
                                        <RiLogoutBoxLine className="text-sm" />
                                        Sign Out
                                    </button>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                ) : (
                    /* Login/Signup Buttons */
                    <div className="hidden lg:flex items-center gap-2">
                        <Link
                            href="/login"
                            className="px-4 py-2 text-caramel hover:text-orange-600 transition font-medium"
                        >
                            Login
                        </Link>
                        <Link
                            href="/signup"
                            className="px-4 py-2 bg-caramel text-white rounded-lg hover:bg-orange-600 transition font-medium"
                        >
                            Sign Up
                        </Link>
                    </div>
                )}
                
                <button
                    className="text-caramel ml-3 hidden text-2xl lg:block"
                    onClick={() => setIsMenuOpen(!isMenuOpen)}
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
                                    className={`px-[30px] py-2.5 ${isActive ? 'bg-caramel text-white' : 'text-caramel'} inline-flex cursor-pointer items-center justify-center gap-2.5 rounded-3xl`}
                                >
                                    {link.name}
                                </Link>
                            )
                        })}
                        
                        {/* Mobile Authentication */}
                        <div className="border-t border-gray-200 pt-4 mt-4">
                            {session ? (
                                <>
                                    <Link
                                        href="/profile"
                                        onClick={() => setIsMenuOpen(false)}
                                        className="flex items-center gap-2 px-[30px] py-2.5 text-caramel hover:bg-gray-100 rounded-3xl transition"
                                    >
                                        <RiUserLine className="text-sm" />
                                        Profile
                                    </Link>
                                    <button
                                        onClick={() => {
                                            handleSignOut()
                                            setIsMenuOpen(false)
                                        }}
                                        className="flex items-center gap-2 px-[30px] py-2.5 text-red-600 hover:bg-red-50 rounded-3xl transition w-full text-left"
                                    >
                                        <RiLogoutBoxLine className="text-sm" />
                                        Sign Out
                                    </button>
                                </>
                            ) : (
                                <>
                                    <Link
                                        href="/login"
                                        onClick={() => setIsMenuOpen(false)}
                                        className="px-[30px] py-2.5 text-caramel hover:bg-gray-100 rounded-3xl transition block"
                                    >
                                        Login
                                    </Link>
                                    <Link
                                        href="/signup"
                                        onClick={() => setIsMenuOpen(false)}
                                        className="px-[30px] py-2.5 bg-caramel text-white hover:bg-orange-600 rounded-3xl transition block"
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
