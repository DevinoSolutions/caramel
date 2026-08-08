'use client'

import { useReducedMotion } from '@/lib/reducedMotion'
import { motion } from 'framer-motion'
import Image from 'next/image'

// The store scroller runs on CSS keyframes rather than a framer x-loop for one
// reason: `animation-play-state: paused` (the hover pause) only acts on CSS
// animations — framer drives transforms through WAAPI/JS, where the property is
// inert, and toggling its `animate` prop instead makes the track slide back to
// its start. Motion profile is a 1:1 port of the loop it replaces (translateX
// 0 → -100% over 30s, linear, forever), so tooling that freezes animations for
// screenshots still lands on the same first frame as before.
const marqueeStyles = `
@keyframes caramel-marquee {
    from { transform: translateX(0); }
    to { transform: translateX(-100%); }
}
.caramel-marquee-track {
    animation: caramel-marquee 30s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
    .caramel-marquee-track { animation: none; }
}
`

const featuredStores = [
    {
        name: 'Amazon',
        desc: 'Worldʼs largest online retailer',
        image: '/amazon.png',
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
    const reduceMotion = useReducedMotion()

    return (
        <section id="supported" className="relative overflow-hidden py-32">
            {/* Background Elements */}
            <div className="absolute inset-0">
                <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-caramel/20 to-transparent"></div>
                <div className="absolute bottom-0 left-0 h-px w-full bg-gradient-to-r from-transparent via-caramel/20 to-transparent"></div>
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
                    <h2 className="mb-8 bg-gradient-to-r from-caramel to-orange-600 bg-clip-text pb-1 text-5xl font-extrabold leading-tight tracking-tight text-transparent lg:text-4xl">
                        3,000+ Supported Stores
                    </h2>
                    <p className="max-w mx-auto text-xl leading-relaxed text-gray-600 dark:text-gray-300 lg:text-lg">
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
                            className="inline-flex items-center rounded-full bg-gradient-to-r from-caramel to-orange-600 px-6 py-3 font-semibold text-white shadow-lg transition-all duration-200 hover:shadow-xl"
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
                    <style>{marqueeStyles}</style>
                    {/* py-6, not py-4: the cards' hover lift and warm shadow
                        reach ~20px below the card and would otherwise be
                        guillotined by this element's own overflow-hidden. */}
                    <div className="relative w-full overflow-hidden py-6 [-webkit-mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)] [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]">
                        <div className="caramel-marquee-track flex gap-4 hover:[animation-play-state:paused]">
                            {[...featuredStores, ...featuredStores].map(
                                (store, index) => (
                                    <div
                                        key={`${store.name}-${index}`}
                                        aria-hidden={
                                            index >= featuredStores.length ||
                                            undefined
                                        }
                                        className="group relative min-w-[280px] flex-shrink-0 overflow-hidden rounded-3xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-8 transition-all duration-300 hover:-translate-y-1 hover:border-caramel/60 hover:shadow-[0_12px_32px_-8px_rgba(234,105,37,0.35)] dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10 lg:min-w-[240px] sm:min-w-[200px] sm:p-6"
                                    >
                                        <div
                                            aria-hidden="true"
                                            className="absolute inset-0 opacity-5"
                                        >
                                            <motion.div
                                                className="h-full w-full"
                                                style={{
                                                    backgroundImage: `
                                                    linear-gradient(90deg, #ea6925 1px, transparent 1px),
                                                    linear-gradient(#ea6925 1px, transparent 1px)
                                                `,
                                                    backgroundSize: '20px 20px',
                                                }}
                                                animate={
                                                    reduceMotion
                                                        ? undefined
                                                        : {
                                                              backgroundPosition:
                                                                  [
                                                                      '0px 0px',
                                                                      '20px 20px',
                                                                      '0px 0px',
                                                                  ],
                                                          }
                                                }
                                                transition={{
                                                    duration: 8,
                                                    repeat: Infinity,
                                                    ease: 'linear',
                                                    repeatType: 'loop',
                                                }}
                                            />
                                        </div>
                                        <div className="relative z-10 text-center">
                                            {/* The chip keeps brand logos on a
                                                light plate in dark mode. They
                                                used to be flattened to white
                                                (`brightness-0 invert`), which
                                                turned Target, Best Buy, eBay and
                                                Walmart into identical blobs. */}
                                            <div className="relative mx-auto mb-6 flex h-20 w-20 items-center justify-center transition-transform duration-300 group-hover:scale-110 dark:rounded-xl dark:bg-white/90 dark:p-2">
                                                {/* eager on purpose: the marquee
                                                    translates the duplicated half
                                                    offscreen, so lazy copies never
                                                    intersect and never load — real
                                                    users see empty tiles cycle in,
                                                    and Argos (animations frozen)
                                                    waits 60s for them and times
                                                    out the home-page screenshot.
                                                    unoptimized on purpose too:
                                                    these are right-sized ≤10KB
                                                    brand PNGs; routing 16 of them
                                                    through sharp on every cold
                                                    load starves 2-core CI runners
                                                    and flakes the nav e2e suite. */}
                                                <Image
                                                    src={store.image}
                                                    alt={`${store.name} logo`}
                                                    width={80}
                                                    height={80}
                                                    loading="eager"
                                                    unoptimized
                                                    className="h-full w-full object-contain"
                                                />
                                            </div>
                                            <h3 className="mb-3 text-2xl font-semibold text-gray-800 dark:text-white sm:text-xl">
                                                {store.name}
                                            </h3>
                                            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                                                {store.desc}
                                            </p>
                                        </div>
                                    </div>
                                ),
                            )}
                        </div>
                    </div>
                </motion.div>

                {/* Call to Action */}
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.15, ease: 'easeOut' }}
                    className="rounded-3xl bg-gradient-to-br from-caramel to-[#c9531a] p-12 text-center text-white shadow-2xl ring-1 ring-inset ring-white/20 dark:border dark:border-caramel/30 dark:bg-caramel/[0.12] dark:bg-none dark:shadow-none dark:ring-0 lg:p-8 sm:p-6"
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
                        className="inline-flex items-center rounded-full bg-white px-8 py-4 font-semibold text-caramel shadow-md transition-all duration-200 hover:bg-orange-50 hover:shadow-xl"
                    >
                        Request a Store
                    </motion.a>
                </motion.div>
            </div>
        </section>
    )
}
