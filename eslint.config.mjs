import next from 'eslint-config-next'

export default [
    ...next,
    {
        rules: {
            'react-hooks/exhaustive-deps': 'off',
            'react-hooks/set-state-in-effect': 'off',
            'react-hooks/refs': 'off',
            'react-hooks/immutability': 'off',
            'no-console': 'off',
            'import/no-anonymous-default-export': 'off',
            '@next/next/no-img-element': 'off',
            'react/no-unescaped-entities': 'off',
        },
    },
    {
        // F-011 — global-error.tsx is a deliberate, permanent exception: it
        // replaces the root layout on last-resort failures and must stay
        // dependency-free, so its one internal link is a raw <a> rather
        // than next/link's <Link> (which needs client router context that
        // may not survive whatever broke the root layout). A file-scoped
        // override instead of an inline eslint-disable comment because the
        // lint-staged autofix chain (oxlint -> eslint --fix -> prettier)
        // was observed stripping inline disable comments near this JSX
        // during pre-commit.
        // `**/` prefix (not a repo-root-relative path) because this array
        // is loaded from two different `files`-glob bases depending on
        // invocation: apps/caramel-app/eslint.config.mjs re-exports it
        // verbatim, so `pnpm lint`/CI (cwd apps/caramel-app) resolve these
        // globs relative to that file, while the root-run husky pre-commit
        // hook (cwd repo root) resolves them relative to this file instead.
        files: ['**/src/app/global-error.tsx'],
        rules: {
            '@next/next/no-html-link-for-pages': 'off',
        },
    },
    {
        // F-013 — `any` erases types at exported boundaries for every
        // caller; ban it repo-wide now that the census is clean. Scoped to
        // `**/*.ts`/`**/*.tsx` (not global) to match the `files` glob
        // `eslint-config-next` itself uses to register the
        // `@typescript-eslint` plugin — a global (unscoped) rule entry
        // would make ESLint look for that plugin on `.js`/`.mjs` files too,
        // where nothing registers it.
        files: ['**/*.ts', '**/*.tsx'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
        },
    },
    {
        // Env-door ban (DESIGN.md §1) — "rules become checks". Server and
        // NEXT_PUBLIC env vars are read ONLY through the zod-validated modules
        // src/lib/env.ts / env.client.ts (fail-fast at boot, one documented
        // contract); a raw `process.env.X` read anywhere else bypasses that
        // door. Was memory-only; now enforced. `**/src/**` (not an absolute
        // path) for the same dual-invocation-base reason as the global-error
        // block above (root husky cwd vs apps/caramel-app cwd).
        //
        // Exempt by SELECTOR: `process.env.NODE_ENV` / `NEXT_RUNTIME` —
        // framework-managed runtime discriminators neither env module owns
        // (env.ts is `server-only`, so client files like providers.tsx/gtag.ts
        // cannot import it regardless), so there is no env-door home to route
        // them through.
        files: ['**/src/**/*.{ts,tsx}'],
        ignores: [
            // The env door itself — the one legitimate home for env reads.
            '**/src/lib/env.ts',
            '**/src/lib/env.client.ts',
            // Instrumentation bootstrapping runs around/before the env door
            // (Sentry init, edge-runtime discrimination) — out of scope.
            '**/src/instrumentation.ts',
            '**/src/instrumentation.client.ts',
            // Documented exception (2026-07-14): decryptJsonData.ts must read
            // NEXT_PUBLIC_API_ENCRYPTION_ENABLED live (not via the clientEnv
            // singleton, which parses once at import) so decryptJsonData.test.ts
            // can flip it per-case with vi.stubEnv. The var stays declared in
            // env.client.ts's schema + .env.example — only this call site's
            // read is dynamic (see the file's own header comment).
            '**/src/lib/securityHelpers/decryptJsonData.ts',
            // Documented exception (2026-08-06): buildInfo.ts holds the commit
            // next.config.mjs's `env` inlines at BUILD time, by rewriting that
            // exact `process.env.GIT_COMMIT_SHA` expression into a string
            // literal. env.ts parses `process.env` as an object and so offers
            // the inliner nothing to rewrite — routing this through the env
            // door would yield undefined at runtime, since nothing sets the
            // var in the running container (see the file's own header).
            '**/src/lib/buildInfo.ts',
        ],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        "MemberExpression[object.object.name='process'][object.property.name='env']:not([property.name=/^(NODE_ENV|NEXT_RUNTIME)$/])",
                    message:
                        'Read env only through src/lib/env.ts (server) or src/lib/env.client.ts (client) — the zod-validated env door (DESIGN.md §1). process.env.NODE_ENV / NEXT_RUNTIME (framework flags) are exempt.',
                },
            ],
        },
    },
    {
        // Reduced-motion door — "rules become checks". framer-motion's
        // useReducedMotion returns null on the server and the REAL preference
        // on the first client render, so every prop branching on it (framer
        // serializes initial/animate into the SSR'd style attribute) makes the
        // hydrating render disagree with the server HTML. React then throws the
        // whole tree away, which silently drops in-flight interactions — that
        // is what broke the navigation e2e specs when the public pages started
        // server-rendering. src/lib/reducedMotion.ts is the hydration-safe
        // replacement; keep the raw hook out so this cannot come back.
        // `**/src/**` for the same dual-invocation-base reason as the blocks
        // above (root husky cwd vs apps/caramel-app cwd).
        files: ['**/src/**/*.{ts,tsx}'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: 'framer-motion',
                            importNames: ['useReducedMotion'],
                            message:
                                "Import useReducedMotion from '@/lib/reducedMotion' — framer's version is not hydration-safe (returns null server-side, the real value on the first client render) and its mismatch regenerates the server tree.",
                        },
                    ],
                },
            ],
        },
    },
]
