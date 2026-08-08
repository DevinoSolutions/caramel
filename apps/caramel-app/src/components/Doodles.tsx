'use client'

import { useReducedMotion } from '@/lib/reducedMotion'
import { motion } from 'framer-motion'

const Doodles = () => {
    const reduceMotion = useReducedMotion()

    return (
        <div
            aria-hidden="true"
            className="pointer-events-none fixed z-[1] h-full w-full"
        >
            {/* Top Right Circle */}
            <motion.svg
                className="absolute -right-48 top-0 h-[40vw] max-h-[500px] w-[40vw] max-w-[500px] -translate-y-1/2 lg:-right-16 lg:top-12"
                viewBox="0 0 200 200"
                fill="none"
                initial={reduceMotion ? false : { opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 1.2, ease: 'easeOut' }}
            >
                <motion.path
                    d="M190,100 C190,160 140,190 100,190 C60,190 10,160 10,100 C10,40 60,10 100,10 C140,10 190,40 190,100Z"
                    stroke="#ea6925"
                    strokeWidth="6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeOpacity="0.15"
                    initial={reduceMotion ? false : { pathLength: 0 }}
                    animate={
                        reduceMotion
                            ? undefined
                            : {
                                  pathLength: [0, 1, 1, 1],
                                  rotate: [0, 0, 360, 360],
                              }
                    }
                    transition={{
                        duration: 14,
                        ease: 'easeInOut',
                        times: [0, 0.3, 0.8, 1], // Path draws first 30%, rotates 30%-80%, pauses 80%-100%
                    }}
                />
                <motion.circle
                    cx="100"
                    cy="100"
                    r="5"
                    fill="#ea6925"
                    fillOpacity="0.2"
                    animate={
                        reduceMotion
                            ? undefined
                            : {
                                  scale: [1, 1.6, 1, 1],
                                  opacity: [0.2, 0.5, 0.2, 0.2],
                              }
                    }
                    transition={{
                        duration: 14,
                        ease: 'easeInOut',
                        times: [0, 0.4, 0.7, 1],
                    }}
                />
            </motion.svg>

            {/* Bottom Left Circle */}
            <motion.svg
                className="absolute -left-32 top-[75vh] h-[32vw] max-h-[400px] w-[32vw] max-w-[400px] -translate-y-1/2 lg:-left-8"
                viewBox="0 0 200 200"
                fill="none"
                initial={reduceMotion ? false : { opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 1.2, ease: 'easeOut', delay: 0.6 }}
            >
                <motion.path
                    d="M190,100 C190,160 140,190 100,190 C60,190 10,160 10,100 C10,40 60,10 100,10 C140,10 190,40 190,100Z"
                    stroke="#da7f52"
                    strokeWidth="6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeOpacity="0.15"
                    initial={reduceMotion ? false : { pathLength: 0 }}
                    animate={
                        reduceMotion
                            ? undefined
                            : {
                                  pathLength: [0, 1, 1, 1],
                                  rotate: [0, 0, -360, -360], // Counter-clockwise rotation
                              }
                    }
                    transition={{
                        duration: 14,
                        ease: 'easeInOut',
                        times: [0, 0.25, 0.75, 1], // Different timing for variety
                        delay: 2, // Start after a delay
                    }}
                />
                <motion.circle
                    cx="100"
                    cy="100"
                    r="5"
                    fill="#da7f52"
                    fillOpacity="0.2"
                    animate={
                        reduceMotion
                            ? undefined
                            : {
                                  scale: [1, 1.6, 1, 1],
                                  opacity: [0.2, 0.5, 0.2, 0.2],
                              }
                    }
                    transition={{
                        duration: 14,
                        ease: 'easeInOut',
                        times: [0, 0.3, 0.6, 1],
                        delay: 2,
                    }}
                />
            </motion.svg>

            {/* Floating Triangle */}
            <motion.div
                className="absolute left-[15vw] top-[15vh] h-6 w-6 border-2 border-[#ea6925]/20"
                style={{ clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' }}
                animate={
                    reduceMotion
                        ? undefined
                        : {
                              y: [0, -25, 0, 0],
                              x: [0, 15, 0, 0],
                              rotate: [0, 0, 180, 180],
                              scale: [1, 1.3, 1, 1],
                          }
                }
                transition={{
                    duration: 10,
                    repeat: Infinity,
                    ease: 'easeInOut',
                    times: [0, 0.4, 0.8, 1],
                }}
            />

            {/* Floating Hexagon */}
            <motion.div
                className="absolute right-[20vw] top-[55vh] h-5 w-5 bg-[#da7f52]/15"
                style={{
                    clipPath:
                        'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
                }}
                animate={
                    reduceMotion
                        ? undefined
                        : {
                              y: [0, 20, 0, 0],
                              x: [0, -10, 0, 0],
                              rotate: [0, 0, 360, 360],
                              scale: [1, 1.2, 1, 1],
                          }
                }
                transition={{
                    duration: 14,
                    repeat: Infinity,
                    ease: 'easeInOut',
                    delay: 1.5,
                    times: [0, 0.3, 0.7, 1],
                }}
            />

            {/* Rotating Rectangle */}
            <motion.div
                className="absolute left-[25vw] top-[35vh] h-10 w-3 rounded-full bg-[#ea6925]/10"
                animate={
                    reduceMotion
                        ? undefined
                        : {
                              rotate: [0, 360, 360, 720],
                              scale: [1, 1.15, 1, 1],
                              opacity: [0.1, 0.3, 0.1, 0.1],
                          }
                }
                transition={{
                    duration: 20,
                    repeat: Infinity,
                    ease: 'linear',
                    times: [0, 0.4, 0.6, 1],
                }}
            />

            {/* Pulsing Ring */}
            <motion.div
                className="absolute right-[30vw] top-[75vh] h-8 w-8 rounded-full border-2 border-[#da7f52]/25"
                animate={
                    reduceMotion
                        ? undefined
                        : {
                              y: [0, -30, 0, 0],
                              scale: [1, 0.9, 1, 1],
                              borderWidth: [2, 5, 2, 2],
                              opacity: [0.25, 0.5, 0.25, 0.25],
                          }
                }
                transition={{
                    duration: 8,
                    repeat: Infinity,
                    ease: 'easeInOut',
                    delay: 2.5,
                    times: [0, 0.4, 0.7, 1],
                }}
            />

            {/* Star SVG */}
            <motion.svg
                className="absolute right-[35vw] top-[25vh] h-10 w-10 opacity-15"
                viewBox="0 0 24 24"
                fill="none"
                animate={
                    reduceMotion
                        ? undefined
                        : {
                              rotate: [0, 0, 360, 360, 360],
                              scale: [1, 1.1, 1, 1, 1],
                          }
                }
                transition={{
                    duration: 25,
                    repeat: Infinity,
                    ease: 'easeInOut',
                    times: [0, 0.2, 0.6, 0.8, 1],
                }}
            >
                <path
                    d="M12 2L15.09 8.26L22 9L17 14L18.18 21L12 17.77L5.82 21L7 14L2 9L8.91 8.26L12 2Z"
                    stroke="#ea6925"
                    strokeWidth="2"
                    fill="#ea6925"
                    fillOpacity="0.15"
                />
            </motion.svg>

            {/* Checkmark SVG */}
            <motion.svg
                className="absolute left-[30vw] top-[65vh] h-9 w-9 opacity-20"
                viewBox="0 0 24 24"
                fill="none"
                animate={
                    reduceMotion
                        ? undefined
                        : {
                              rotate: [0, 0, 180, 180, 360, 360],
                              scale: [1, 1.25, 1, 1, 1, 1],
                              opacity: [0.2, 0.4, 0.2, 0.2, 0.2, 0.2],
                          }
                }
                transition={{
                    duration: 18,
                    repeat: Infinity,
                    ease: 'easeInOut',
                    delay: 0.8,
                    times: [0, 0.15, 0.4, 0.55, 0.8, 1],
                }}
            >
                <path
                    d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
                    fill="#da7f52"
                    fillOpacity="0.25"
                />
            </motion.svg>

            {/* Floating Dot Cluster */}
            <motion.div
                className="absolute right-[10vw] top-[45vh] h-4 w-4 rounded-full bg-[#ea6925]/20"
                animate={
                    reduceMotion
                        ? undefined
                        : {
                              y: [0, -15, 0, 0],
                              x: [0, 10, 0, 0],
                              scale: [1, 1.4, 1, 1],
                          }
                }
                transition={{
                    duration: 8,
                    repeat: Infinity,
                    ease: 'easeInOut',
                    delay: 3.5,
                    times: [0, 0.4, 0.75, 1],
                }}
            />
            <motion.div
                className="absolute right-[12vw] top-[47vh] h-2 w-2 rounded-full bg-[#da7f52]/20"
                animate={
                    reduceMotion
                        ? undefined
                        : {
                              y: [0, -10, 0, 0],
                              x: [0, 5, 0, 0],
                              scale: [1, 1.3, 1, 1],
                          }
                }
                transition={{
                    duration: 6,
                    repeat: Infinity,
                    ease: 'easeInOut',
                    delay: 4,
                    times: [0, 0.5, 0.8, 1],
                }}
            />
        </div>
    )
}

export default Doodles
