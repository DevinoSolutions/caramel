/* eslint.config.cjs – CommonJS flat-config for ESLint 9  */

const eslintPluginImport = require('eslint-plugin-import')
const eslintPluginPrettier = require('eslint-plugin-prettier')
const eslintPluginHTML = require('eslint-plugin-html')

module.exports = [
    {
        // GENERATED — not hand-maintained (F-006). Regenerate via
        // `pnpm --filter caramel-app generate:coupon-constants`.
        // Build outputs (old build: dist*/; WXT: .output/, .wxt/) are
        // artifacts, never sources — the parity harness owns their contents.
        // .size-cache/ joined them 2026-08-19: it holds the MINIFIED bundles
        // `pnpm size` writes for size-limit to weigh, and linting them is
        // meaningless (two of them fail to even parse, since minifiers reuse
        // identifiers across the concatenated files). Left unignored, whether
        // `pnpm lint` passed depended on whether `pnpm size` had been run
        // first — a gate that answers differently by invocation order.
        ignores: [
            'coupon-constants.generated.js',
            'dist/**',
            'dist-*/**',
            '.output/**',
            '.wxt/**',
            '.size-cache/**',
        ],
    },
    {
        files: ['**/*.{js,html}'],

        /* Parser & globals */
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module', // lets you use ES-modules in browser code
            globals: { window: true, document: true },
        },

        /* Plugins */
        plugins: {
            import: eslintPluginImport,
            prettier: eslintPluginPrettier,
            html: eslintPluginHTML,
        },

        /* Base rule sets */
        rules: {
            // turn off “can’t resolve” for extension scripts
            'import/no-unresolved': 'off',

            // allow console.error but warn on other console calls
            'no-console': ['warn', { allow: ['error'] }],

            // run Prettier as an ESLint rule
            'prettier/prettier': 'warn',
        },
    },
]
