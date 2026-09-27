import typescriptParser from '@typescript-eslint/parser'
import { Linter, RuleTester } from 'eslint'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import rootConfig from '../../../../eslint.config.mjs'
import noInsensitivePrismaLiteralMatch from '../../../../tools/eslint-rules/no-insensitive-prisma-literal-match.mjs'

// The lint ban on Prisma's `mode: 'insensitive'` beside a literal-match
// operator, which compiles to an UNESCAPED `ILIKE` (siteSuggestionIdentity.ts).
// Each invalid case below is a spelling of the same filter; the ones marked
// NEW slipped past the `no-restricted-syntax` selector this rule replaced.

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const ruleTester = new RuleTester({
    languageOptions: { parser: typescriptParser },
})

const reported = (operator: string) => [
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
        ],
    },
)

describe('the root eslint config', () => {
    const repoRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../..',
    )

    it('runs the ban on app source beside the env-door selector, neither replacing the other', () => {
        // One file breaking both rules: the ban used to share the env door's
        // `no-restricted-syntax` entry because a second one for the same files
        // replaces the first; as its own rule it must not cost the env door.
        const code = [
            "export const lookup = (email: string) => ({ email: { equals: email, mode: 'insensitive' as const } })",
            'export const secret = process.env.SECRET',
        ].join('\n')

        const messages = new Linter({ cwd: repoRoot }).verify(
            code,
            rootConfig,
            path.join(repoRoot, 'apps/caramel-app/src/lib/lookup.ts'),
        )

        expect(messages.map(message => message.ruleId).sort()).toEqual([
            'caramel/no-insensitive-prisma-literal-match',
            'no-restricted-syntax',
        ])
    })
})
