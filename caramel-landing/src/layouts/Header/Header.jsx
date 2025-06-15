import L from "next/link";
import {AnimatePresence, motion} from "framer-motion";
import React, {useEffect, useState} from "react";
import {RiCloseFill, RiMenu3Fill} from "react-icons/ri";
import Image from "next/image";
import {usePathname} from "next/navigation";
import {useWindowSize} from "@/hooks/useWindowSize";
import ThemeToggle from "@/components/ThemeToggle";
import {useScrollDirection} from "@/hooks/useScrollDirection";

const links = [
    {name: "Home", url: "/"},
    {name: "Privacy", url: "/privacy"},
    {name: "Supported Sites", url: "/supported-sites"},
];

const Link = motion.create(L);

export default function Header({scrollRef}) {
    const [isInView, setIsInView] = useState(true);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const {isScrollingDown, isScrollingUp} = useScrollDirection(scrollRef);
    const {windowSize} = useWindowSize();

    useEffect(() => {
    }, [windowSize]);
    const pathname = usePathname();

    useEffect(() => {
        if(isScrollingDown){
            setIsInView(false);
        }
        if(isScrollingUp){
            setIsInView(true);
        }
    }, [isScrollingDown, isScrollingUp]);


    return (
        <motion.header
            initial={{y: 0, opacity: 1, scale: 1}}
            animate={{
                y: isInView ? 0 : "-200%",
                opacity: isInView ? 1 : 0,
                scale: isInView ? 1 : 1.05,
            }}
            transition={{duration: 0.3}}
            className={`  z-[999]  lg:bg-white lg:dark:bg-darkerBg lg:rounded-[28px] lg:shadow w-full max-w-[min(75rem,93svw)] sticky rounded-2xl p-4 px-8 flex items-center justify-between mx-auto top-4 lg:py-3 py-4`}
        >
            <Link
                href="/"
                className="w-[185px] h-full flex absolute ml-5 lg:static lg:ml-0"
            >
                    <Image
                        src="/full-logo.png"
                        alt="logo"
                        height={120}
                        width={120}
                        className="cursor-pointer w-4/5 sm:w-5/12 mt-auto mb-auto"
                    />
            </Link>
            <motion.div
                className={`px-[26px] py-[15px] lg:hidden w-full mx-auto bg-white dark:bg-darkerBg rounded-[28px] shadow justify-center flex items-start gap-6`}>
                {links.map(link => {
                    const isActive = pathname === link.url;

                    return (
                        <Link
                            key={link.name}
                            href={link.url || ""}
                            className={`px-[30px] hover:scale-105 py-2.5 ${isActive ? 'bg-caramel text-white' : 'text-caramel'} rounded-3xl justify-center items-center gap-2.5 inline-flex cursor-pointer`}
                        >
                            {link.name}
                        </Link>
                    );
                })}
            </motion.div>
            <ThemeToggle className="lg:relative lg:ml-auto absolute lg:right-auto -right-4"/>
            <button
                className="text-caramel hidden ml-3 lg:block text-2xl "
                onClick={() => setIsMenuOpen(!isMenuOpen)}
            >
                {isMenuOpen ? <RiCloseFill/> : <RiMenu3Fill/>}
            </button>
            <AnimatePresence>
                {isMenuOpen && (
                    <motion.div
                        initial={{y: -50, opacity: 0}}
                        animate={{y: 0, opacity: 1}}
                        exit={{y: -50, opacity: 0}}
                        className="bg-inherit absolute h-[calc(90svh-100%)] pt-11 w-full gap-4 shadow top-full left-0 rounded-xl mt-4 flex flex-col justify-center !pl-4 !pr-4 py-2 uppercase font-medium text-xs tracking-wider overscroll-none overflow-auto"
                    >
                        {links.map((link) => {
                            const isActive = pathname === link.url;
                            return (
                                <Link
                                    onClick={() => setIsMenuOpen(false)}
                                    key={link.name}
                                    href={link.url || ""}
                                    className={`px-[30px] py-2.5 ${isActive ? 'bg-caramel text-white' : 'text-caramel'} rounded-3xl justify-center items-center gap-2.5 inline-flex cursor-pointer`}
                                >
                                    {link.name}
                                </Link>
                            );
                        })}
                        <div className="h-full"/>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.header>
    );
}
