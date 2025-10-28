'use client'

import Doodles from '@/components/Doodles'
import PrivacyPolicy from '@/components/PrivacyPolicy'
import { motion } from 'framer-motion'

export default function PrivacyPageClient() {
    return (
        <main className="dark:bg-darkBg relative -mt-[6.7rem] w-full overflow-x-clip">
            <Doodles />
            <div className="scroll-smooth">
                <section className="text-gray-8 00 relative mt-[5rem] flex min-h-[50vh] flex-col justify-center overflow-hidden px-6 py-16 dark:text-white">
                    <div className="mx-auto max-w-6xl text-center">
                        <motion.div
                            initial={{ opacity: 0, y: 30 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.6, ease: 'easeOut' }}
                            className="mb-8"
                        >
                            <h1 className="from-caramel mb-6 bg-gradient-to-r to-orange-600 bg-clip-text text-5xl font-extrabold leading-[90px] tracking-tight text-transparent md:text-3xl lg:text-4xl">
                                Privacy Policy
                            </h1>
                            <p className="mx-auto max-w-3xl text-xl leading-relaxed text-gray-600 lg:text-lg dark:text-gray-300">
                                We value your privacy and are committed to
                                protecting your personal information
                            </p>
                        </motion.div>
                    </div>
                </section>
                <motion.div
                    className="relative h-px"
                    initial={{ scaleX: 0 }}
                    whileInView={{ scaleX: 1 }}
                    viewport={{ once: true }}
                    transition={{ duration: 2, delay: 0.4 }}
                >
                    <div className="h-px bg-gradient-to-r from-transparent via-orange-500/40 to-transparent"></div>
                    <div className="absolute inset-0 h-px bg-gradient-to-r from-transparent via-orange-300/20 to-transparent blur-sm"></div>
                </motion.div>
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                        duration: 0.6,
                        delay: 0.2,
                        ease: 'easeOut',
                    }}
                    className="mx-auto max-w-6xl px-6 pb-16 lg:px-8"
                >
                    <PrivacyPolicy />
                </motion.div>
            </div>
        </main>
    )
}
