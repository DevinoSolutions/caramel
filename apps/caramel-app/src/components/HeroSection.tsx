'use client'

import { motion } from 'framer-motion'
import Image from 'next/image'
import React from 'react'
import { FaGithub } from 'react-icons/fa'

export default function HeroSection() {
    return (
        <section className="relative mt-[5rem] flex min-h-screen flex-col justify-center overflow-hidden px-6 py-16 text-gray-800 dark:text-white">
            {/* Floating elements */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <motion.div
                    className="bg-caramel/8 absolute left-1/4 top-1/4 h-32 w-32 rounded-full blur-xl"
                    animate={{
                        x: [0, 30, 0],
                        y: [0, -20, 0],
                    }}
                    transition={{
                        duration: 8,
                        repeat: Infinity,
                        ease: 'easeInOut',
                    }}
                />
                <motion.div
                    className="bg-orange-300/8 absolute right-1/4 top-3/4 h-24 w-24 rounded-full blur-xl"
                    animate={{
                        x: [0, -25, 0],
                        y: [0, 25, 0],
                    }}
                    transition={{
                        duration: 10,
                        repeat: Infinity,
                        ease: 'easeInOut',
                        delay: 2,
                    }}
                />
                <motion.div
                    className="bg-caramel/6 absolute right-1/3 top-1/2 h-20 w-20 rounded-full blur-lg"
                    animate={{
                        x: [0, 20, 0],
                        y: [0, -15, 0],
                    }}
                    transition={{
                        duration: 12,
                        repeat: Infinity,
                        ease: 'easeInOut',
                        delay: 4,
                    }}
                />
            </div>

            <div className="relative z-10 mx-auto max-w-6xl text-center">
                <motion.h1
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6 }}
                    className="mb-6 flex flex-col justify-center text-5xl font-bold lg:text-4xl md:text-3xl"
                >
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.6 }}
                        className="m-auto mb-4 text-gray-700 dark:text-white"
                    >
                        Welcome to
                    </motion.div>
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{
                            duration: 0.8,
                            delay: 0.3,
                            type: 'spring',
                            stiffness: 100,
                            damping: 15,
                        }}
                        className="relative"
                        whileHover={{ scale: 1.02 }}
                    >
                        <Image
                            src="/full-logo.png"
                            alt="Caramel Logo"
                            height={2000}
                            width={2000}
                            className="m-auto max-w-lg drop-shadow-lg lg:w-full"
                            priority
                        />
                    </motion.div>
                </motion.h1>

                <motion.p
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, delay: 0.4 }}
                    className="mx-auto mb-12 max-w-4xl text-xl leading-relaxed text-gray-600 dark:text-gray-300 lg:text-lg md:text-base"
                >
                    The{' '}
                    <motion.a
                        href="https://github.com/DevinoSolutions/caramel"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="cursor-pointer rounded px-1 font-semibold text-caramel transition-all duration-300 hover:bg-orange-500/10"
                        whileHover={{
                            backgroundColor: 'rgba(234, 105, 37, 0.1)',
                            scale: 1.02,
                        }}
                    >
                        open-source
                    </motion.a>{' '}
                    and{' '}
                    <motion.a
                        href="#why-not"
                        className="cursor-pointer rounded px-1 font-semibold text-caramel transition-all duration-300 hover:bg-orange-500/10"
                        whileHover={{
                            backgroundColor: 'rgba(234, 105, 37, 0.1)',
                            scale: 1.02,
                        }}
                    >
                        privacy-first
                    </motion.a>{' '}
                    alternative to Honey. Automatically finds and applies the
                    best coupon codes at checkout —
                    <motion.a
                        href="#why-not"
                        className="cursor-pointer rounded px-1 font-semibold text-caramel transition-all duration-300 hover:bg-orange-500/10"
                        whileHover={{
                            backgroundColor: 'rgba(234, 105, 37, 0.1)',
                            scale: 1.02,
                        }}
                    >
                        {' '}
                        without selling your data
                    </motion.a>{' '}
                    or{' '}
                    <motion.a
                        href="#why-not"
                        className="cursor-pointer rounded px-1 font-semibold text-caramel transition-all duration-300 hover:bg-orange-500/10"
                        whileHover={{
                            backgroundColor: 'rgba(234, 105, 37, 0.1)',
                            scale: 1.02,
                        }}
                    >
                        hijacking creatorsʼ commissions
                    </motion.a>
                    .
                </motion.p>

                {/* Stats Section */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, delay: 0.6 }}
                    className="mb-12 flex items-center justify-center gap-8 lg:gap-6 md:gap-4 sm:flex-col sm:gap-6"
                >
                    {[
                        { value: '5,000+', label: 'Supported Stores' },
                        { value: '100%', label: 'Open Source' },
                        { value: '0%', label: 'Data Selling' },
                    ].map((stat, index) => (
                        <React.Fragment key={stat.label}>
                            <motion.div
                                className="text-center"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{
                                    duration: 0.4,
                                    delay: 0.6 + index * 0.1,
                                }}
                                whileHover={{ scale: 1.05 }}
                            >
                                <div className="text-3xl font-bold text-caramel lg:text-2xl md:text-xl">
                                    {stat.value}
                                </div>
                                <div className="text-sm text-gray-600 dark:text-gray-400">
                                    {stat.label}
                                </div>
                            </motion.div>
                            {index < 2 && (
                                <div className="h-12 w-px bg-gray-300 dark:bg-gray-600 sm:hidden"></div>
                            )}
                        </React.Fragment>
                    ))}
                </motion.div>

                {/* CTA Buttons */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, delay: 0.8 }}
                    className="flex justify-center gap-4 md:flex-col md:items-center md:gap-3"
                >
                    <motion.a
                        href="#install-extension"
                        className="rounded-full bg-gradient-to-r from-caramel to-orange-600 px-8 py-4 font-semibold text-black shadow-lg transition-all duration-300 hover:from-orange-600 hover:to-caramel hover:shadow-xl"
                        initial={{
                            scale: 1,
                            boxShadow: '0 0 10px rgba(234,105,37,0.6)',
                        }}
                        animate={{
                            scale: [1, 1.12, 1],
                            boxShadow: [
                                '0 0 10px rgba(234,105,37,0.6)',
                                '0 0 28px rgba(234,105,37,1)',
                                '0 0 10px rgba(234,105,37,0.6)',
                            ],
                        }}
                        transition={{
                            duration: 1.2,
                            repeat: Infinity,
                            ease: 'easeInOut',
                        }}
                        whileHover={{
                            scale: 1.05,
                            boxShadow: '0 20px 40px rgba(234,105,37,0.35)',
                        }}
                        whileTap={{ scale: 0.95 }}
                    >
                        Install Extension
                    </motion.a>
                    <motion.a
                        href="https://github.com/DevinoSolutions/caramel"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group inline-flex items-center gap-3 rounded-full border-2 border-caramel/40 bg-transparent px-6 py-3 text-sm font-semibold text-caramel backdrop-blur-sm transition-all duration-300 hover:border-caramel hover:bg-caramel hover:text-white"
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                    >
                        <FaGithub className="h-4 w-4 transition-transform duration-300 group-hover:rotate-12" />
                        View Source Code
                    </motion.a>
                    <motion.a
                        href="#features"
                        className="rounded-full border-2 border-gray-300/60 bg-transparent px-8 py-4 font-semibold text-gray-700 backdrop-blur-sm transition-all duration-300 hover:border-caramel hover:text-caramel dark:border-gray-600/60 dark:text-gray-300"
                        whileHover={{
                            scale: 1.05,
                            borderColor: 'rgb(234, 105, 37)',
                        }}
                        whileTap={{ scale: 0.95 }}
                    >
                        Why Choose Caramel?
                    </motion.a>
                </motion.div>
            </div>
        </section>
    )
}
