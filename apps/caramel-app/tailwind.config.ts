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
            },
        },
    },
    plugins: [],
}

export default config
