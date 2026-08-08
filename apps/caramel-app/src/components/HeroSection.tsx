'use client'

// HeroSection — split hero. On desktop (lg+ = the UNPREFIXED base, since this
// repo's Tailwind screens are max-width/desktop-first) the existing hero copy
// aligns LEFT (~55%) and an interactive 3D caramel coupon fills the RIGHT
// (~45%). Below lg it collapses to the original single centered column and the
// 3D canvas never mounts at all — phones pay zero WebGL cost.
//
// "Not heavy" gating (brief): the HeroTicketScene chunk (`three`) is a separate
// next/dynamic ssr:false component mounted ONLY once every gate passes — the
// browser is idle (requestIdleCallback, setTimeout fallback) AND a real WebGL
// context exists AND motion is allowed AND the viewport is lg+ (matchMedia,
// re-checked on resize). Until then the right column shows HeroCouponPoster —
// a server-rendered DOM/CSS twin of the 3D scene: the SAME three stat coupons
// (shared HERO_STATS + ticketNotchMask, espresso ink, dashed perforation) at
// the same scatter positions, so the canvas cross-fade is a material swap,
// not a composition change. The right column reserves its box up front, and
// the reveal is choreographed: on the canvas's first-frame onReady signal the
// canvas fades in (500ms) while each poster ticket fades out on a per-coupon
// stagger timed to its 3D twin's drop-in entrance — one continuous
// materialization, zero CLS, no flash of empty space. The poster is
// ALSO the permanent presentation for no-WebGL / reduced-motion desktops, and
// because it SSRs, the three stats exist as crawlable HTML (SEO bonus).
// The scene's frameloop is paused (frameloop='never') whenever the hero is
// scrolled out of view via an IntersectionObserver.

import { ThemeContext } from '@/lib/contexts'
import {
    formatStat,
    formatStatDigits,
    HERO_STATS,
    useCountUp,
} from '@/lib/heroStats'
import { useReducedMotion } from '@/lib/reducedMotion'
import { ticketNotchMask } from '@/lib/ticketMask'
import { detectWebGL } from '@/lib/webglSupport'
import { motion } from 'framer-motion'
import dynamic from 'next/dynamic'
import Image from 'next/image'
import React, { useContext, useEffect, useRef, useState } from 'react'
import { FaGithub } from 'react-icons/fa'

const HeroTicketScene = dynamic(() => import('./HeroTicketScene'), {
    ssr: false,
})

const revealEase: [number, number, number, number] = [0.22, 1, 0.36, 1]

// HeroCouponPoster — the server-rendered DOM/CSS twin of HeroTicketScene's
// three-stat composition, and the ONE placeholder for both of its roles:
// (a) the instant face of the hero canvas box until the WebGL scene signals
// ready (the parent cross-fades this out), and (b) the PERMANENT presentation
// on no-WebGL / reduced-capability / reduced-motion desktops. Index-matched
// to HERO_STATS and to the scene's SCATTER: each spot mirrors that coupon's
// anchor (as % of the layout box), z-order (depth), base rotZ, relative size
// and type scale, so the poster→canvas cross-fade reads as the same three
// coupons gaining glass and light — not a layout jump. Same brand recipe as
// every ticket in the app: caramel gradient face, ticketNotchMask side
// notches, dashed mid perforation, espresso print-ink type (the 3D STAT_INK)
// with the small raised suffix. Values render via useCountUp, which SSRs the
// FINAL numbers — so the stats are real crawlable HTML and the count-up only
// replays after hydration. NOT aria-hidden: this is the accessible/crawler
// face of the stats on desktop (the mobile StatCards row below lg covers
// small viewports).
const POSTER_INK = '#4a1c05'
interface PosterSpot {
    left: string
    top: string
    width: string
    aspect: string
    rotate: number
    z: number
    radius: string
    notch: string
    valueSize: string
    labelSize: string
    floatDuration: number
    floatDelay: number
    // Cross-fade stagger (seconds after canvasReady) — MUST mirror the same
    // coupon's SCATTER[i].enterDelay in HeroTicketScene: the poster ticket
    // fades out exactly while its 3D twin plays its entrance, so the eye
    // reads one continuous materialization per coupon instead of a global
    // A-then-B swap (owner 2026-07-30: "when they appear suddenly — not
    // good").
    fadeDelay: number
}
// Poster ticket fade-out length. The last coupon (open source, delay 0.3s)
// finishes at ~0.9s — inside the 3D entrance window (its twin rests at 1.0s),
// so the DOM ticket vanishes just before its glass twin settles.
const POSTER_FADE_DURATION_S = 0.6
// Geometry mapping (reference 470×544 layout box, scene fit ≈ 0.67 → ≈77
// px/world): anchor (x,y) → left/top %, ticket width = 2.5 · scale ·
// perspective, type = the 3D 0.54/0.17 world sizes through the same factor.
const POSTER_SPOTS: PosterSpot[] = [
    {
        left: '35%',
        top: '68%',
        width: '13.5rem',
        aspect: '2.5 / 1.6',
        rotate: -4,
        z: 30,
        radius: '1.1rem',
        notch: '0.95rem',
        valueSize: '2.7rem',
        labelSize: '0.8rem',
        floatDuration: 5.8,
        floatDelay: 0.1,
        fadeDelay: 0,
    },
    {
        left: '46%',
        top: '29%',
        width: '11.75rem',
        aspect: '2.5 / 1.6',
        rotate: 4,
        z: 20,
        radius: '0.95rem',
        notch: '0.85rem',
        valueSize: '2.35rem',
        labelSize: '0.7rem',
        floatDuration: 4.9,
        floatDelay: 0.35,
        fadeDelay: 0.3,
    },
    {
        left: '72%',
        top: '51%',
        width: '10.25rem',
        aspect: '2.5 / 1.6',
        rotate: -6,
        z: 10,
        radius: '0.85rem',
        notch: '0.72rem',
        valueSize: '2.05rem',
        labelSize: '0.62rem',
        floatDuration: 6.6,
        floatDelay: 0.55,
        fadeDelay: 0.15,
    },
]

function PosterCoupon({
    stat,
    spot,
    index,
    start,
    reduce,
    fadeOut,
}: {
    stat: (typeof HERO_STATS)[number]
    spot: PosterSpot
    index: number
    start: boolean
    reduce: boolean
    // True once the live canvas is presenting: this ticket then fades out on
    // its own fadeDelay stagger while its 3D twin plays its entrance.
    fadeOut: boolean
}): React.JSX.Element {
    const n = useCountUp(stat.value, start, reduce)
    return (
        // Plain wrapper owns the anchor transform (center on the % spot +
        // base rotation) so framer's animated transforms on the inner nodes
        // never overwrite it.
        <div
            className="absolute"
            style={{
                left: spot.left,
                top: spot.top,
                width: spot.width,
                zIndex: spot.z,
                transform: `translate(-50%, -50%) rotate(${spot.rotate}deg)`,
            }}
        >
            <motion.div
                initial={
                    reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.9 }
                }
                animate={
                    fadeOut
                        ? { opacity: 0, y: 0, scale: 1 }
                        : { opacity: 1, y: 0, scale: 1 }
                }
                transition={
                    fadeOut
                        ? {
                              duration: POSTER_FADE_DURATION_S,
                              delay: spot.fadeDelay,
                              ease: 'easeOut',
                          }
                        : {
                              duration: 0.6,
                              delay: 0.35 + index * 0.12,
                              ease: revealEase,
                          }
                }
            >
                {/* Inner looping float on its own node so the one-shot
                    entrance transform above never fights the loop; each coupon
                    gets its own duration + delay, so no two ever bob in sync
                    (the DOM cousin of the scene's per-coupon
                    frequencies/phases). */}
                <motion.div
                    animate={reduce ? undefined : { y: [0, -9, 0] }}
                    transition={
                        reduce
                            ? undefined
                            : {
                                  duration: spot.floatDuration,
                                  delay: spot.floatDelay,
                                  repeat: Infinity,
                                  ease: 'easeInOut',
                              }
                    }
                    className="relative"
                    style={{ aspectRatio: spot.aspect }}
                >
                    <div
                        className="absolute inset-0 bg-gradient-to-br from-caramel via-orange-500 to-orange-600 shadow-caramel-lg"
                        style={{
                            borderRadius: spot.radius,
                            ...ticketNotchMask(spot.notch, '50%'),
                        }}
                    />
                    <div
                        className="absolute inset-0 bg-gradient-to-tr from-white/30 via-transparent to-transparent"
                        style={{
                            borderRadius: spot.radius,
                            ...ticketNotchMask(spot.notch, '50%'),
                        }}
                    />
                    {/* Perforation: a row of discrete dashes (repeating
                        gradient, ~11 dashes across like the 3D Perforation
                        row) rather than border-dashed, whose long dashes read
                        as a different motif than the scene's. */}
                    <div
                        className="absolute inset-x-[9%] top-1/2 h-[3px] -translate-y-1/2"
                        style={{
                            backgroundImage:
                                'repeating-linear-gradient(90deg, rgba(255,242,230,0.85) 0 8px, transparent 8px 19px)',
                        }}
                    />
                    {/* Value: cap-centered at 37.5% (3D VALUE_Y 0.2 over half-h
                    0.8), suffix at 0.6× raised to cap-align — the DOM twin of
                    StatValueText. */}
                    <div
                        className="absolute inset-x-0 top-[37.5%] -translate-y-1/2 whitespace-nowrap text-center font-black leading-none tracking-tight"
                        style={{ color: POSTER_INK, fontSize: spot.valueSize }}
                    >
                        {formatStatDigits(n, stat)}
                        <span className="align-[0.45em] text-[0.6em]">
                            {stat.suffix}
                        </span>
                    </div>
                    <div
                        className="absolute inset-x-0 top-[70.5%] -translate-y-1/2 whitespace-nowrap text-center font-bold uppercase tracking-[0.08em]"
                        style={{ color: POSTER_INK, fontSize: spot.labelSize }}
                    >
                        {stat.label}
                    </div>
                </motion.div>
            </motion.div>
        </div>
    )
}

function HeroCouponPoster({
    start,
    reduce,
    fadeOut,
}: {
    start: boolean
    reduce: boolean
    // Flips true when the canvas presents its first frame (onReady): the
    // glow bed fades over ~0.9s and each ticket fades on its own stagger —
    // the poster side of the choreographed materialization.
    fadeOut: boolean
}): React.JSX.Element {
    return (
        <div className="pointer-events-none absolute inset-0">
            <div
                aria-hidden="true"
                className="absolute inset-0 overflow-hidden transition-opacity duration-[900ms] ease-out"
                style={{ opacity: fadeOut ? 0 : 1 }}
            >
                <div className="absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-caramel/25 blur-3xl dark:bg-caramel/20" />
                <div className="absolute left-[38%] top-[32%] h-36 w-36 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orange-300/30 blur-2xl" />
            </div>
            {HERO_STATS.map((stat, index) => (
                <PosterCoupon
                    key={stat.label}
                    stat={stat}
                    spot={POSTER_SPOTS[index]}
                    index={index}
                    start={start}
                    reduce={reduce}
                    fadeOut={fadeOut}
                />
            ))}
        </div>
    )
}

// MOBILE-ONLY row of the three hero stats, rendered as small uniform caramel
// coupon-ticket cards (shared ticketNotchMask) in normal flow under the copy,
// each counting its number up from 0 on first paint. Desktop presentations
// are HeroTicketScene (live) and HeroCouponPoster (placeholder/fallback);
// all three share the same HERO_STATS data so they never drift.
function StatCard({
    stat,
    index,
    start,
    reduce,
}: {
    stat: (typeof HERO_STATS)[number]
    index: number
    start: boolean
    reduce: boolean
}): React.JSX.Element {
    const n = useCountUp(stat.value, start, reduce)
    return (
        <motion.div
            initial={
                reduce ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.9 }
            }
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{
                duration: 0.5,
                delay: 0.5 + index * 0.12,
                ease: revealEase,
            }}
            whileHover={reduce ? undefined : { y: -4, scale: 1.03 }}
            className="relative w-32 rounded-2xl bg-gradient-to-br from-caramel to-orange-600 px-5 py-4 text-white shadow-caramel-lg md:w-28"
            style={ticketNotchMask('0.55rem', '50%')}
        >
            <div className="text-3xl font-extrabold leading-none tracking-tight md:text-2xl">
                {formatStat(n, stat)}
            </div>
            <div className="mt-1.5 text-[0.7rem] font-medium uppercase tracking-wide text-white/85">
                {stat.label}
            </div>
        </motion.div>
    )
}

// A centered row of the three uniform stat cards (mobile flow).
function StatCards({
    start,
    reduce,
}: {
    start: boolean
    reduce: boolean
}): React.JSX.Element {
    return (
        <div className="flex flex-wrap items-stretch justify-center gap-3">
            {HERO_STATS.map((stat, index) => (
                <StatCard
                    key={stat.label}
                    stat={stat}
                    index={index}
                    start={start}
                    reduce={reduce}
                />
            ))}
        </div>
    )
}

export default function HeroSection() {
    const reduceMotion = useReducedMotion()
    const { isDarkMode } = useContext(ThemeContext)
    const sectionRef = useRef<HTMLElement>(null)

    // desktop = viewport is lg+ (min-width:1024, the complement of Tailwind's
    // max-width `lg`); idle = browser has gone idle after paint; webglOK = a
    // real GL context is available; active = hero is intersecting (frameloop);
    // canvasReady = GL context created (cross-fade the poster out).
    const [desktop, setDesktop] = useState(false)
    const [idle, setIdle] = useState(false)
    const [webglOK, setWebglOK] = useState(false)
    const [active, setActive] = useState(true)
    const [canvasReady, setCanvasReady] = useState(false)
    // Flips true after first paint so the stat coupons count up on load.
    const [statsStarted, setStatsStarted] = useState(false)

    useEffect(() => {
        setStatsStarted(true)
    }, [])

    useEffect(() => {
        const mq = window.matchMedia('(min-width: 1024px)')
        const update = (): void => setDesktop(mq.matches)
        update()
        mq.addEventListener('change', update)
        return () => mq.removeEventListener('change', update)
    }, [])

    useEffect(() => {
        setWebglOK(detectWebGL())
    }, [])

    // Defer the 3D chunk until the browser is idle so it never competes with
    // first paint / hydration.
    useEffect(() => {
        if (reduceMotion) return
        if (typeof window.requestIdleCallback === 'function') {
            // timeout: the hero's infinite blob animations can starve true
            // idle periods, so cap the wait — 1.5s is past paint+hydration.
            const id = window.requestIdleCallback(() => setIdle(true), {
                timeout: 1500,
            })
            return () => window.cancelIdleCallback(id)
        }
        const timer = window.setTimeout(() => setIdle(true), 200)
        return () => window.clearTimeout(timer)
    }, [reduceMotion])

    // Frameloop gate: pause the canvas whenever the hero scrolls out of view.
    useEffect(() => {
        const el = sectionRef.current
        if (!el) return
        const observer = new IntersectionObserver(
            entries => setActive(entries.some(entry => entry.isIntersecting)),
            { rootMargin: '0px', threshold: 0 },
        )
        observer.observe(el)
        return () => observer.disconnect()
    }, [])

    const showCanvas = !reduceMotion && webglOK && desktop && idle

    return (
        <section
            ref={sectionRef}
            className="relative mt-[5rem] flex min-h-screen flex-col justify-center overflow-hidden px-6 py-16 text-gray-800 dark:text-white sm:px-5"
        >
            {/* Floating elements */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 overflow-hidden"
            >
                <motion.div
                    className="bg-caramel/8 absolute left-1/4 top-1/4 h-32 w-32 rounded-full blur-xl"
                    animate={
                        reduceMotion
                            ? undefined
                            : {
                                  x: [0, 30, 0],
                                  y: [0, -20, 0],
                              }
                    }
                    transition={{
                        duration: 8,
                        repeat: Infinity,
                        ease: 'easeInOut',
                    }}
                />
                <motion.div
                    className="bg-orange-300/8 absolute right-1/4 top-3/4 h-24 w-24 rounded-full blur-xl"
                    animate={
                        reduceMotion
                            ? undefined
                            : {
                                  x: [0, -25, 0],
                                  y: [0, 25, 0],
                              }
                    }
                    transition={{
                        duration: 10,
                        repeat: Infinity,
                        ease: 'easeInOut',
                        delay: 2,
                    }}
                />
                <motion.div
                    className="bg-caramel/6 absolute right-1/3 top-1/2 h-20 w-20 rounded-full blur-lg"
                    animate={
                        reduceMotion
                            ? undefined
                            : {
                                  x: [0, 20, 0],
                                  y: [0, -15, 0],
                              }
                    }
                    transition={{
                        duration: 12,
                        repeat: Infinity,
                        ease: 'easeInOut',
                        delay: 4,
                    }}
                />
            </div>

            <div className="relative z-10 mx-auto flex w-full max-w-6xl items-center gap-12 lg:flex-col lg:gap-10">
                {/* LEFT column: the hero copy, re-aligned left on desktop and
                    re-centered (as before) below lg. */}
                <div className="flex w-[55%] flex-col items-start text-left lg:w-full lg:items-center lg:text-center">
                    <motion.h1
                        initial={
                            reduceMotion
                                ? { opacity: 0 }
                                : { opacity: 0, y: 20 }
                        }
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.6, ease: revealEase }}
                        className="mb-6 flex flex-col items-start text-5xl font-bold tracking-tight lg:items-center lg:text-4xl md:text-3xl"
                    >
                        <motion.div
                            initial={
                                reduceMotion
                                    ? { opacity: 0 }
                                    : { opacity: 0, y: 20 }
                            }
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.6, ease: revealEase }}
                            className="mb-4 text-gray-700 dark:text-white"
                        >
                            Welcome to
                        </motion.div>
                        <motion.div
                            initial={
                                reduceMotion
                                    ? { opacity: 0 }
                                    : { opacity: 0, scale: 0.9 }
                            }
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{
                                duration: 0.8,
                                delay: 0.3,
                                type: 'spring',
                                stiffness: 100,
                                damping: 15,
                            }}
                            className="relative"
                            whileHover={
                                reduceMotion ? undefined : { scale: 1.02 }
                            }
                        >
                            {/* unoptimized on purpose: the wordmark is a 40KB
                                PNG, but width=2000 makes the optimizer build a
                                w=3840 variant ON the LCP critical path — a
                                cold-cache sharp conversion that starves 2-core
                                CI runners (nav e2e flakes) for zero visual
                                gain. Static serve is instant and cacheable. */}
                            {/* alt completes the h1: the wordmark IS the rest of
                                the heading, so crawlers (which count img alt
                                inside an h1) read "Welcome to Caramel — the
                                open-source coupon extension" instead of a bare
                                "Welcome to". Alt text is not rendered. */}
                            <Image
                                src="/full-logo.png"
                                alt="Caramel — the open-source coupon extension"
                                height={2000}
                                width={2000}
                                className="max-w-md drop-shadow-lg lg:mx-auto lg:w-full"
                                priority
                                unoptimized
                            />
                        </motion.div>
                    </motion.h1>

                    <motion.p
                        initial={
                            reduceMotion
                                ? { opacity: 0 }
                                : { opacity: 0, y: 10 }
                        }
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                            duration: 0.6,
                            delay: 0.4,
                            ease: revealEase,
                        }}
                        className="mb-10 max-w-xl text-xl leading-relaxed text-gray-600 dark:text-gray-300 lg:mx-auto lg:max-w-2xl lg:text-lg md:text-base"
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
                        alternative to Honey. Automatically finds and applies
                        the best coupon codes at checkout —
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

                    {/* CTA Buttons — sized to sit inline on one row on desktop
                        (stacked below md). The stats moved to the coupon cards
                        in the right column. */}
                    <motion.div
                        initial={
                            reduceMotion
                                ? { opacity: 0 }
                                : { opacity: 0, y: 20 }
                        }
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                            duration: 0.6,
                            delay: 0.8,
                            ease: revealEase,
                        }}
                        className="flex flex-wrap items-center justify-start gap-3 lg:justify-center md:flex-col md:items-center"
                    >
                        <motion.a
                            href="#install-extension"
                            className="rounded-full bg-gradient-to-r from-caramel to-orange-600 px-6 py-3 text-sm font-semibold text-black shadow-lg transition-all duration-300 hover:from-orange-600 hover:to-caramel hover:shadow-xl md:w-full md:text-center"
                            initial={{
                                boxShadow: '0 0 10px rgba(234,105,37,0.5)',
                            }}
                            animate={
                                reduceMotion
                                    ? {
                                          boxShadow:
                                              '0 0 18px rgba(234,105,37,0.6)',
                                      }
                                    : {
                                          scale: [1, 1.04, 1],
                                          boxShadow: [
                                              '0 0 10px rgba(234,105,37,0.5)',
                                              '0 0 24px rgba(234,105,37,0.85)',
                                              '0 0 10px rgba(234,105,37,0.5)',
                                          ],
                                      }
                            }
                            transition={{
                                duration: 2.2,
                                repeat: reduceMotion ? 0 : Infinity,
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
                            className="group inline-flex items-center justify-center gap-2 rounded-full border-2 border-caramel/40 bg-transparent px-5 py-3 text-sm font-semibold text-caramel backdrop-blur-sm transition-all duration-300 hover:border-caramel hover:bg-caramel hover:text-white md:w-full"
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.95 }}
                        >
                            <FaGithub className="h-4 w-4 transition-transform duration-300 group-hover:rotate-12" />
                            View Source Code
                        </motion.a>
                        <motion.a
                            href="#features"
                            className="rounded-full border-2 border-gray-300/60 bg-transparent px-6 py-3 text-sm font-semibold text-gray-700 backdrop-blur-sm transition-all duration-300 hover:border-caramel hover:text-caramel dark:border-gray-600/60 dark:text-gray-300 md:w-full md:text-center"
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

                {/* RIGHT column: on desktop, ONE interactive WebGL box holds
                    the three large 3D stat coupons scattered around the
                    center at varied depths (soft independent floating +
                    pointer reaction — see HeroTicketScene's SCATTER).
                    HeroCouponPoster — the SSR'd DOM twin of that exact
                    composition — paints instantly underneath and stays as the
                    permanent presentation for reduced-motion / no-WebGL
                    desktop. The reveal is CHOREOGRAPHED, not a hard swap
                    (owner 2026-07-30): on canvasReady the canvas fades in
                    over 500ms while each poster ticket fades out on its own
                    stagger (POSTER_SPOTS[i].fadeDelay) exactly as its 3D twin
                    plays its staggered drop-in entrance (SCATTER[i]
                    .enterDelay) — one continuous materialization per coupon.
                    Below lg the box is hidden (phones never mount three) and
                    the DOM stat cards render in normal flow under the copy. */}
                <div className="relative flex w-[45%] flex-col items-center lg:w-full">
                    {/* DESKTOP 3D box: reserved up front; zero CLS. The
                        poster layer keeps opacity 1 — its coupons fade
                        INDIVIDUALLY (staggered) via fadeOut, so a wrapper
                        fade here would smear the stagger into one global
                        dissolve. */}
                    <div className="relative h-[34rem] w-full lg:hidden">
                        <div
                            className="absolute inset-0"
                            style={{
                                pointerEvents: canvasReady ? 'none' : undefined,
                            }}
                        >
                            <HeroCouponPoster
                                start={statsStarted}
                                reduce={reduceMotion}
                                fadeOut={canvasReady}
                            />
                        </div>
                        {/* The canvas raster BLEEDS 48px/40px past the layout
                            box (must match CANVAS_BLEED_X/Y_PX in
                            HeroTicketScene, which subtracts the bleed from its
                            fit math) so a tilted coupon or drifting droplet
                            never touches the raster edge — the section's
                            overflow-hidden still crops safely far away at the
                            SECTION edge. 48px of left bleed = exactly the
                            column gap (gap-12), so the pointer-capturing
                            canvas never covers the copy column's links. The
                            anchor box keeps its reserved h-[34rem] — zero CLS. */}
                        {showCanvas && (
                            <div
                                className="absolute -inset-x-[48px] -inset-y-[40px] transition-opacity duration-500 ease-out"
                                style={{ opacity: canvasReady ? 1 : 0 }}
                            >
                                <HeroTicketScene
                                    active={active}
                                    isDark={isDarkMode}
                                    onReady={() => setCanvasReady(true)}
                                />
                            </div>
                        )}
                    </div>

                    {/* MOBILE stats: the DOM stat cards in normal flow (the 3D
                        box above is hidden below lg). */}
                    <div className="hidden w-full lg:flex lg:justify-center">
                        <StatCards start={statsStarted} reduce={reduceMotion} />
                    </div>
                </div>
            </div>
        </section>
    )
}
