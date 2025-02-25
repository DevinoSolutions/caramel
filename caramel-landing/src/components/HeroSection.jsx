"use client";

import React from "react";
import { motion } from "framer-motion";
import Image from "next/image";

export default function HeroSection() {


    return (
        <section
            className="relative mt-[5rem] min-h-screen dark:text-white flex flex-col justify-center overflow-hidden px-6 py-16 text-gray-800"
        >
            <div className="relative z-10 max-w-6xl mx-auto text-center">
                <motion.h1
                    initial={{opacity: 0, y: 20}}
                    animate={{opacity: 1, y: 0}}
                    transition={{duration: 0.6}}
                    className="text-5xl md:text-3xl flex flex-col justify-center font-bold mb-6"
                >
                    {/* Animated text */}
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.6 }}
                        className="
                        m-auto dark:text-white text-black/70 drop-shadow-2xl"
                    >
                        Welcome to
                    </motion.div>
                    <Image
                        src="/full-logo.png"
                        alt="logo"
                        height={2000}
                        width={2000}
                        className="m-auto "
                    />
                </motion.h1>
                <motion.p
                    initial={{opacity: 0, y: 10}}
                    animate={{opacity: 1, y: 0}}
                    transition={{duration: 0.8}}
                    className="text-xl md:text-sm text-gray-600 dark:text-white max-w-2xl mx-auto mb-8"
                >
                    Caramel is the best way to save money on your online shopping. Our
                    browser extension automatically applies the best coupon code at
                    checkout.
                </motion.p>
            </div>
        </section>
    );
}
