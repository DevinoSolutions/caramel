'use client'

import { ThemeContext } from '@/lib/contexts'
import { motion } from 'framer-motion'
import Image from 'next/image'
import { useContext } from 'react'

export default function StoreButtons() {
    const { isDarkMode } = useContext(ThemeContext)
    return (
        <div className="mt-20 flex flex-col justify-center gap-4">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
                className="m-auto w-full text-start text-3xl font-bold text-black drop-shadow-2xl dark:text-white md:text-lg"
            >
                Where to get Caramel?
            </motion.div>
            <div className="grid grid-cols-2 gap-8 xs:grid-cols-1">
                <motion.a
                    href="https://chrome.google.com/webstore"
                    target="_blank"
                    className="pointer-events-none flex items-center gap-2 rounded-xl border-[1.5px] border-black px-3 py-1.5 text-black/70 opacity-60 transition-transform duration-200 ease-in-out hover:scale-105 hover:border-caramel hover:bg-caramel hover:text-white dark:border-white dark:text-white"
                >
                    <div className="w-10">
                        <Image
                            src={isDarkMode ? '/apple-white.png' : '/apple.png'}
                            alt="Chrome"
                            width={40}
                            height={40}
                        />
                    </div>
                    <div className="w-full">
                        <div className="text-sm font-extrabold md:text-xs">
                            Download on
                        </div>
                        <div className="flex w-full justify-between text-2xl md:text-sm">
                            <span>Play Store</span>
                            <span className="my-auto text-xs">Coming soon</span>
                        </div>
                    </div>
                </motion.a>
                <motion.a
                    target="_blank"
                    href="https://chrome.google.com/webstore"
                    className="pointer-events-none flex items-center gap-2 rounded-xl border-[1.5px] border-black px-3 py-1.5 text-black/70 opacity-65 transition-transform duration-200 ease-in-out hover:scale-105 hover:border-caramel hover:bg-caramel hover:text-white dark:border-white dark:text-white"
                >
                    <div className="w-10">
                        <Image
                            src="/chrome.png"
                            alt="Chrome"
                            width={40}
                            height={40}
                        />
                    </div>
                    <div className="w-full">
                        <div className="text-sm font-extrabold md:text-xs">
                            Download on the
                        </div>
                        <div className="flex justify-between text-2xl md:text-sm">
                            <span>Chrome extension store</span>
                            <span className="my-auto text-xs">Coming soon</span>
                        </div>
                    </div>
                </motion.a>
            </div>
        </div>
    )
}
