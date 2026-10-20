import type { Config } from 'tailwindcss'

const config: Config = {
    darkMode: 'class',
    content: ['./src/**/*.{js,jsx,ts,tsx}'],
    theme: {
        screens: {
            '3xl': { max: '1600px' },
            // => @media (max-width: 1535px) { ... }

            '2xl': { max: '1535px' },
            // => @media (max-width: 1535px) { ... }

            xl: { max: '1279px' },
            // => @media (max-width: 1279px) { ... }

            lg: { max: '1023px' },
            // => @media (max-width: 1023px) { ... }

            md: { max: '767px' },
            // => @media (max-width: 767px) { ... }

            sm: { max: '639px' },
            // => @media (max-width: 639px) { ... }
            xs: { max: '475px' },
            // => @media (max-width: 475px) { ... }
            tall: { raw: '(max-height: 800px)' },
        },
        extend: {
            colors: {
                caramel: '#ea6925',
                caramelLight: '#da7f52',
                darkBg: '#191A1C',
                darkerBg: '#101010',
                // Warm raised-card surface for dark mode. Tailwind's gray-800/900
                // (#1f2937/#111827) are blue-hued and clash with the warm brand
                // near-blacks above; this charcoal keeps R>G>B (warm cast) and
                // sits visibly above both darkBg and darkerBg.
                darkSurface: '#1E1916',
            },
            boxShadow: {
                // Warm brand shadows for card/CTA depth (landing refinement)
                'caramel-sm': '0 6px 18px -8px rgba(234, 105, 37, 0.25)',
                'caramel-lg': '0 20px 40px -12px rgba(234, 105, 37, 0.3)',
            },
            transitionTimingFunction: {
                // Soft decelerating ease shared by landing hover/reveal transitions
                caramel: 'cubic-bezier(0.22, 1, 0.36, 1)',
                'motion-out': 'var(--motion-ease-out)',
            },
            transitionDuration: {
                fast: 'var(--motion-dur-fast)',
                base: 'var(--motion-dur-base)',
                slow: 'var(--motion-dur-slow)',
            },
            // Shared enter keyframes for the motion pass: transform + opacity
            // only. Gate the translate/scale ones with motion-safe: at use sites.
            keyframes: {
                'motion-fade-in': {
                    from: { opacity: '0' },
                    to: { opacity: '1' },
                },
                'motion-fade-up': {
                    from: {
                        opacity: '0',
                        transform: 'translateY(var(--motion-rise, 6px))',
                    },
                    to: { opacity: '1', transform: 'translateY(0)' },
                },
                'motion-scale-in': {
                    from: { opacity: '0', transform: 'scale(0.96)' },
                    to: { opacity: '1', transform: 'scale(1)' },
                },
            },
            animation: {
                'motion-fade-in':
                    'motion-fade-in var(--motion-dur-base) var(--motion-ease-out) both',
                'motion-fade-up':
                    'motion-fade-up var(--motion-dur-base) var(--motion-ease-out) both',
                'motion-scale-in':
                    'motion-scale-in var(--motion-dur-base) var(--motion-ease-out) both',
            },
        },
    },
    plugins: [],
}

export default config
