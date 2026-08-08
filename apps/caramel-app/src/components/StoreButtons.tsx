'use client'

import { CHROME_WEB_STORE_URL, FIREFOX_ADDONS_URL } from '@/lib/brandLinks'
import { motion } from 'framer-motion'
import { FaChrome, FaFirefox } from 'react-icons/fa'

export default function StoreButtons() {
    return (
        <div className="mt-20 flex flex-col justify-center gap-4">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
                className="m-auto w-full text-start text-3xl font-bold tracking-tight text-black drop-shadow-2xl dark:text-white md:text-lg"
            >
                Where to get Caramel?
            </motion.div>
            <div className="grid grid-cols-2 gap-8 xs:grid-cols-1">
                <motion.a
                    href={CHROME_WEB_STORE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-xl border-[1.5px] border-black px-3 py-1.5 text-black transition-transform duration-200 ease-in-out hover:scale-105 hover:border-caramel hover:bg-caramel hover:text-white dark:border-white dark:text-white"
                >
                    <div className="w-10">
                        <FaChrome aria-hidden="true" size={40} />
                    </div>
                    <div className="w-full">
                        <div className="text-sm font-extrabold md:text-xs">
                            Download on the
                        </div>
                        <div className="flex w-full justify-between text-2xl md:text-sm">
                            <span>Chrome Web Store</span>
                        </div>
                    </div>
                </motion.a>
                <motion.a
                    target="_blank"
                    href={FIREFOX_ADDONS_URL}
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-xl border-[1.5px] border-black px-3 py-1.5 text-black transition-transform duration-200 ease-in-out hover:scale-105 hover:border-caramel hover:bg-caramel hover:text-white dark:border-white dark:text-white"
                >
                    <div className="w-10">
                        <FaFirefox aria-hidden="true" size={40} />
                    </div>
                    <div className="w-full">
                        <div className="text-sm font-extrabold md:text-xs">
                            Get it on
                        </div>
                        <div className="flex justify-between text-2xl md:text-sm">
                            <span>Firefox Add-ons</span>
                        </div>
                    </div>
                </motion.a>
            </div>
        </div>
    )
}
