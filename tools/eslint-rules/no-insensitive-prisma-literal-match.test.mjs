import { Linter, RuleTester } from 'eslint'
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import rootConfig from '../../eslint.config.mjs'
import noInsensitivePrismaLiteralMatch from './no-insensitive-prisma-literal-match.mjs'

// The lint ban on Prisma's `mode: 'insensitive'` beside a literal-match
// operator, which compiles to an UNESCAPED `ILIKE` (siteSuggestionIdentity.ts).
// Each invalid case below is a spelling of the same filter; the ones marked
// NEW slipped past the `no-restricted-syntax` selector this rule replaced.
//
// Lives beside the rule, NOT under apps/caramel-app/tests: the prod image is
// built from `turbo prune caramel-app --docker`, which ships the app's tree
// without the repo root, and `next build` type-checks every .ts the app's
// tsconfig includes (tests too). A test there importing the root config and
// this rule broke the Docker build with TS2307. Run it from the root with
// `pnpm test:eslint-rules` (CI: the `unit` job).

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

// The TypeScript parser the repo's lint runs .ts files through, taken from
// eslint-config-next's `next/typescript` block rather than imported:
// @typescript-eslint/parser is a caramel-app devDependency, not a root one,
// so an import here would only resolve through pnpm's hoisting.
const typescriptParser = rootConfig.find(
    config => config.name === 'next/typescript',
)?.languageOptions?.parser
if (!typescriptParser) {
    throw new Error(
        'The root eslint config has no `next/typescript` block with a parser any more. Point this test at the TypeScript parser the config uses now.',
    )
}

const ruleTester = new RuleTester({
    languageOptions: { parser: typescriptParser },
})

const reported = operator => [
    { messageId: 'unescapedIlike', data: { operator } },
]

ruleTester.run(
    'caramel/no-insensitive-prisma-literal-match',
    noInsensitivePrismaLiteralMatch,
    {
        valid: [
            // Exact match on a folded value: the shape the ban points to.
            'prisma.user.findFirst({ where: { email: { equals: email } } })',
            "prisma.user.findFirst({ where: { email: { equals: email, mode: 'default' } } })",
            // `in` / `notIn` compile to LOWER(col) IN (LOWER($1), ...): equality.
            "prisma.user.findMany({ where: { email: { in: emails, mode: 'insensitive' } } })",
            "prisma.user.findMany({ where: { email: { notIn: emails, mode: 'insensitive' } } })",
            // A substring search box is a pattern by intent, not an identity.
            "prisma.store.findMany({ where: { name: { contains: query, mode: 'insensitive' } } })",
            // The resolution boundary: a `mode` that arrives as a parameter is
            // not provably insensitive, so it is not reported.
            'function filter(mode) { return { email: { equals: email, mode } } }',
            "let mode = 'insensitive'; mode = 'default'; find({ equals: email, mode })",
            // A ternary with no provably insensitive branch.
            "function filter(strict, other) { return find({ equals: email, mode: strict ? 'default' : other }) }",
            // KNOWN MISSES, named in the rule's header: each of these DOES
            // compile to the unescaped ILIKE, and the rule does not see it.
            // Move a case to `invalid` when the rule learns it.
            'const { insensitive } = Prisma.QueryMode\nfind({ equals: email, mode: insensitive })',
            "const CASE_INSENSITIVE = { mode: 'insensitive' } as const\nfind({ equals: email, mode: CASE_INSENSITIVE.mode })",
            "enum Mode { CaseInsensitive = 'insensitive' }\nfind({ equals: email, mode: Mode.CaseInsensitive })",
            "const caseInsensitive = { mode: 'insensitive' } as const\nfind({ equals: email, ...caseInsensitive })",
        ],
        invalid: [
            // Already caught by the old selector (regression guards).
            {
                code: "prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })",
                errors: reported('equals'),
            },
            {
                code: "find({ mode: 'insensitive', equals: email })",
                errors: reported('equals'),
            },
            {
                code: "find({ equals: email, mode: 'insensitive' as const })",
                errors: reported('equals'),
            },
            {
                code: "find({ equals: email, mode: 'insensitive' satisfies Prisma.QueryMode })",
                errors: reported('equals'),
            },
            // NEW: the other literal-match operators.
            {
                code: "find({ startsWith: prefix, mode: 'insensitive' })",
                errors: reported('startsWith'),
            },
            {
                code: "find({ endsWith: suffix, mode: 'insensitive' })",
                errors: reported('endsWith'),
            },
            {
                code: "find({ not: email, mode: 'insensitive' })",
                errors: reported('not'),
            },
            // NEW: quoted and computed keys, checked by their value.
            {
                code: "find({ 'equals': email, mode: 'insensitive' })",
                errors: reported('equals'),
            },
            {
                code: "find({ equals: email, 'mode': 'insensitive' })",
                errors: reported('equals'),
            },
            {
                code: "find({ ['equals']: email, mode: 'insensitive' })",
                errors: reported('equals'),
            },
            // NEW: the enum member instead of the string.
            {
                code: 'find({ equals: email, mode: Prisma.QueryMode.insensitive })',
                errors: reported('equals'),
            },
            {
                code: "find({ equals: email, mode: Prisma.QueryMode['insensitive'] })",
                errors: reported('equals'),
            },
            // NEW: the string as a template literal.
            {
                code: 'find({ equals: email, mode: `insensitive` })',
                errors: reported('equals'),
            },
            // NEW: shorthand `mode`, and a named constant, resolved through
            // their single `const` binding.
            {
                code: "const mode = 'insensitive'\nfind({ equals: email, mode })",
                errors: reported('equals'),
            },
            {
                code: "const mode = 'insensitive' as const\nfunction lookup(email: string) { return find({ equals: email, mode }) }",
                errors: reported('equals'),
            },
            {
                code: 'const CASE_INSENSITIVE = Prisma.QueryMode.insensitive\nconst mode = CASE_INSENSITIVE\nfind({ equals: email, mode })',
                errors: reported('equals'),
            },
            // NEW: two operators in one filter, each reported.
            {
                code: "find({ startsWith: a, endsWith: b, mode: 'insensitive' })",
                errors: [...reported('startsWith'), ...reported('endsWith')],
            },
            // NEW: a ternary or a fallback that can pick 'insensitive'. One
            // branch taking it is enough to ship the unescaped ILIKE.
            {
                code: "find({ equals: email, mode: loose ? 'insensitive' : 'default' })",
                errors: reported('equals'),
            },
            {
                code: "find({ equals: email, mode: strict ? 'default' : Prisma.QueryMode.insensitive })",
                errors: reported('equals'),
            },
            {
                code: "const mode = loose ? 'insensitive' : 'default'\nfind({ equals: email, mode })",
                errors: reported('equals'),
            },
            {
                code: "find({ equals: email, mode: options.mode ?? 'insensitive' })",
                errors: reported('equals'),
            },
            {
                code: 'find({ equals: email, mode: loose && Prisma.QueryMode.insensitive })',
                errors: reported('equals'),
            },
        ],
    },
)

describe('the root eslint config', () => {
    const repoRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../..',
    )
    const appDir = path.join(repoRoot, 'apps/caramel-app')
    const RULE_ID = 'caramel/no-insensitive-prisma-literal-match'

    // Plain JS on purpose, so the same line parses as .ts and as .mjs.
    const insensitiveEquals =
        "export const lookup = email => ({ email: { equals: email, mode: 'insensitive' } })"

    const ruleIdsFor = (cwd, code, file, config = rootConfig) =>
        new Linter({ cwd })
            .verify(code, config, path.join(repoRoot, file))
            .map(message => message.ruleId)
            .sort()

    // The scope checks below parse every file with the TypeScript parser.
    // Driven through the Linter API from the repo root, next's babel parser
    // (.js/.mjs/.mts) fails with "Cannot find module 'next/babel'", although
    // the eslint CLI parses those files from either base. These checks are
    // about which files the rule runs on, not about parsing.
    const configParsingAsTypeScript = [
        ...rootConfig,
        { languageOptions: { parser: typescriptParser } },
    ]

    // The config is loaded from two `files`-glob bases: the repo root (husky
    // lint-staged) and apps/caramel-app (`pnpm lint`, the CI lint job), whose
    // eslint.config.mjs re-exports the root one.
    const bases = [
        { name: 'repo root (husky lint-staged)', cwd: repoRoot },
        { name: 'apps/caramel-app (pnpm lint, CI)', cwd: appDir },
    ]

    for (const base of bases) {
        describe(`loaded from ${base.name}`, () => {
            it('runs the ban on app source beside the env-door selector, neither replacing the other', () => {
                // One file breaking both rules: the ban used to share the env
                // door's `no-restricted-syntax` entry because a second one for
                // the same files replaces the first; as its own rule it must
                // not cost the env door.
                const code = [
                    "export const lookup = (email: string) => ({ email: { equals: email, mode: 'insensitive' as const } })",
                    'export const secret = process.env.SECRET',
                ].join('\n')

                assert.deepEqual(
                    ruleIdsFor(
                        base.cwd,
                        code,
                        'apps/caramel-app/src/lib/lookup.ts',
                    ),
                    [RULE_ID, 'no-restricted-syntax'],
                )
            })

            // Outside src/: scripts that write to the database, e2e support
            // that seeds and cleans it, prisma seeds, the app's own tests and
            // config files.
            for (const file of [
                'apps/caramel-app/scripts/bridge-sync.ts',
                'apps/caramel-app/scripts/render-support-email-preview.mts',
                'apps/caramel-app/e2e/support/db.ts',
                'apps/caramel-app/prisma/seed.ts',
                'apps/caramel-app/tests/unit/lookup.test.ts',
                'apps/caramel-app/next.config.mjs',
                'apps/caramel-app/scripts/build-sha.mjs',
            ]) {
                it(`runs the ban on ${file}`, () => {
                    assert.deepEqual(
                        ruleIdsFor(
                            base.cwd,
                            insensitiveEquals,
                            file,
                            configParsingAsTypeScript,
                        ),
                        [RULE_ID],
                    )
                })
            }
        })
    }

    it('leaves the extension alone: the ban is scoped to the app that talks to Prisma', () => {
        assert.deepEqual(
            ruleIdsFor(
                repoRoot,
                insensitiveEquals,
                'apps/caramel-extension/utils/lookup.ts',
                configParsingAsTypeScript,
            ),
            [],
        )
    })
})
