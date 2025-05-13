/* eslint.config.cjs – CommonJS flat-config for ESLint 9  */

const eslintPluginImport = require('eslint-plugin-import')
const eslintPluginPrettier = require('eslint-plugin-prettier')
const eslintPluginHTML = require('eslint-plugin-html')

module.exports = [
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