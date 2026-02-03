'use client'

import { ThemeContext } from '@/lib/contexts'
import { motion } from 'framer-motion'
import Image from 'next/image'
import { useContext } from 'react'

const featuredStores = [
    {
        name: 'Amazon',
        desc: 'Worldʼs largest online retailer',
        image: '/amazon.png',
        imageLight: '/amazon-light.png',
        category: 'marketplace',
    },
    {
        name: 'eBay',
        desc: 'Auction marketplace for buyers & sellers',
        image: '/ebay.png',
        category: 'marketplace',
    },
    {
        name: 'Codecademy',
        desc: 'Interactive platform to learn coding',
        image: '/codeAcademy.png',
        category: 'education',
    },
    {
        name: 'Best Buy',
        desc: 'Electronics and tech retailer',
        image: '/bestbuy.png',
        category: 'electronics',
    },
    {
        name: 'Target',
        desc: 'Department store chain',
        image: '/target.png',
        category: 'retail',
    },
    {
        name: 'Walmart',
        desc: 'Multinational retail corporation',
        image: '/walmart.png',
        category: 'retail',
    },
    {
        name: 'Nike',
        desc: 'Athletic footwear and apparel',
        image: '/nike.png',
        category: 'fashion',
    },
    {
        name: 'Adidas',
        desc: 'Sports clothing and accessories',
        image: '/adidas.png',
        category: 'fashion',
    },
]

export default function SupportedSection() {
    const { isDarkMode } = useContext(ThemeContext)

    return (
        <section id="supported" className="relative overflow-hidden py-32">
            {/* Background Elements */}
            <div className="absolute inset-0">
                <div className="via-caramel/20 absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent to-transparent"></div>
                <div className="via-caramel/20 absolute bottom-0 left-0 h-px w-full bg-gradient-to-r from-transparent to-transparent"></div>
            </div>

            <div className="relative z-10 mx-auto max-w-7xl px-6 lg:px-8">
                {/* Header Section */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, ease: 'easeOut' }}
                    className="mb-20 text-center"
                >
                    <h2 className="from-caramel mb-8 bg-gradient-to-r to-orange-600 bg-clip-text text-5xl font-extrabold leading-[80px] tracking-tight text-transparent lg:text-4xl">
                        5,000+ Supported Stores
                    </h2>
                    <p className="max-w mx-auto text-xl leading-relaxed text-gray-600 lg:text-lg dark:text-gray-300">
                        From major retailers to niche marketplaces, Caramel
                        works everywhere you shop online.
                    </p>
                    <motion.div className="mt-8">
                        <motion.a
                            href="/supported-stores"
                            whileHover={{
                                scale: 1.05,
                                transition: { duration: 0.2 },
                            }}
                            whileTap={{ scale: 0.95 }}
                            className="from-caramel inline-flex items-center rounded-full bg-gradient-to-r to-orange-600 px-6 py-3 font-semibold text-white shadow-lg transition-all duration-200 hover:shadow-xl"
                        >
                            View All Supported Stores
                        </motion.a>
                    </motion.div>
                </motion.div>

                {/* Carousel View */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.2, ease: 'easeOut' }}
                    className="mb-24"
                >
                    <div className="relative w-full overflow-hidden py-4">
                        <motion.div
                            className="flex gap-4"
                            animate={{ x: ['0%', '-100%'] }}
                            transition={{
                                x: {
                                    repeat: Infinity,
                                    repeatType: 'loop',
                                    duration: 30,
                                    ease: 'linear',
                                },
                            }}
                        >
                            {[...featuredStores, ...featuredStores].map(
                                (store, index) => (
                                    <motion.div
                                        key={`${store.name}-${index}`}
                                        className="from-caramel/5 to-caramel/5 dark:from-caramel/10 dark:to-caramel/10 border-caramel/20 dark:border-caramel/30 group relative min-w-[280px] flex-shrink-0 overflow-hidden rounded-3xl border bg-gradient-to-br via-orange-50/30 p-8 sm:min-w-[200px] sm:p-6 lg:min-w-[240px] dark:via-orange-900/20"
                                        whileHover={{
                                            scale: 1.02,
                                            y: -3,
                                            boxShadow:
                                                '0 15px 30px rgba(234,105,37,0.12)',
                                            transition: { duration: 0.2 },
                                        }}
                                    >
                                        <div className="absolute inset-0 opacity-5">
                                            <motion.div
                                                className="h-full w-full"
                                                style={{
                                                    backgroundImage: `
                                                    linear-gradient(90deg, #ea6925 1px, transparent 1px),
                                                    linear-gradient(#ea6925 1px, transparent 1px)
                                                `,
                                                    backgroundSize: '20px 20px',
                                                }}
                                                animate={{
                                                    backgroundPosition: [
                                                        '0px 0px',
                                                        '20px 20px',
                                                        '0px 0px',
                                                    ],
                                                }}
                                                transition={{
                                                    duration: 8,
                                                    repeat: Infinity,
                                                    ease: 'linear',
                                                    repeatType: 'loop',
                                                }}
                                            />
                                        </div>
                                        <div className="relative z-10 text-center">
                                            <div className="relative mx-auto mb-6 flex h-20 w-20 items-center justify-center">
                                                <Image
                                                    src={
                                                        isDarkMode &&
                                                        store.imageLight
                                                            ? store.imageLight
                                                            : store.image
                                                    }
                                                    alt={store.name}
                                                    width={80}
                                                    height={80}
                                                    className={`object-contain ${isDarkMode ? 'brightness-0 invert' : ''}`}
                                                />
                                            </div>
                                            <h3 className="mb-3 text-2xl font-semibold text-gray-800 sm:text-xl dark:text-white">
                                                {store.name}
                                            </h3>
                                            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                                                {store.desc}
                                            </p>
                                        </div>
                                    </motion.div>
                                ),
                            )}
                        </motion.div>
                    </div>
                </motion.div>

                {/* Call to Action */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.6, ease: 'easeOut' }}
                    className="from-caramel rounded-3xl bg-gradient-to-r to-orange-600 p-12 text-center text-white shadow-2xl lg:p-8"
                >
                    <h3 className="mb-6 text-3xl font-semibold tracking-tight lg:text-2xl">
                        Donʼt See Your Favorite Store?
                    </h3>
                    <p className="mx-auto mb-8 max-w-2xl text-lg leading-relaxed opacity-90">
                        Weʼre constantly adding new stores to our platform.
                        Request yours today!
                    </p>
                    <motion.a
                        href="https://github.com/DevinoSolutions/caramel/issues/new?assignees=&labels=store-request&projects=&template=store-request.md&title=%5BStore+Request%5D+Add+support+for+"
                        target="_blank"
                        rel="noopener noreferrer"
                        whileHover={{
                            scale: 1.05,
                            transition: { duration: 0.2 },
                        }}
                        whileTap={{ scale: 0.95 }}
                        className="text-caramel inline-flex items-center rounded-full bg-white px-8 py-4 font-semibold shadow-md transition-all duration-200 hover:bg-orange-50 hover:shadow-xl"
                    >
                        Request a Store
                    </motion.a>
                </motion.div>
            </div>
        </section>
    )
}
