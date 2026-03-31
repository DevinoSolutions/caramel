'use client'

import { motion } from 'framer-motion'
import Image from 'next/image'

export default function Footer() {
    const currentYear = new Date().getFullYear()

    return (
        <footer className="bg-caramel text-white">
            {/* Copyright and Powered By */}
            <div className="container mx-auto px-6 py-6">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                    viewport={{ once: true }}
                    className="text-center"
                >
                    <div className="flex flex-col items-center gap-3">
                        <p className="text-sm text-white">
                            © {currentYear} Caramel. All Rights Reserved.
                        </p>
                        <div className="flex items-center gap-2">
                            <span className="text-sm text-white">
                                Powered by
                            </span>
                            <a
                                href="https://devino.ca?utm_source=caramel_landing&utm_medium=footer"
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label="Devino Solutions Website"
                                className="inline-block"
                            >
                                <Image
                                    src="/devino.png"
                                    alt="Devino Solutions logo"
                                    width={60}
                                    height={20}
                                    className="inline-block"
                                />
                            </a>
                        </div>
                    </div>
                </motion.div>
            </div>
        </footer>
    )
}
