import { Linter, RuleTester } from 'eslint'
import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import rootConfig from '../../eslint.config.mjs'
import noRawClientIpHeader from './no-raw-client-ip-header.mjs'

// The lint ban on naming a client-IP header outside src/lib/clientIp.ts (#256:
// Better Auth shared one rate-limit bucket across all visitors because the IP
// was read from the wrong header behind Cloudflare + Traefik). Lives beside
// the rule for the reason no-insensitive-prisma-literal-match.test.mjs gives.
// Run from the root with `pnpm test:eslint-rules`.

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const reported = header => [
    { messageId: 'rawClientIpHeader', data: { header } },
]

new RuleTester().run('caramel/no-raw-client-ip-header', noRawClientIpHeader, {
    valid: [
        "headers.get('user-agent')",
        "import { readClientIp } from '@/lib/clientIp'\nreadClientIp(req.headers)",
        // Prose naming the header is a comment, not a literal.
        '// CF-Connecting-IP first\nconst a = 1',
        'headers.get(`${name}`)',
    ],
    invalid: [
        {
            code: "req.headers.get('cf-connecting-ip')",
            errors: reported('cf-connecting-ip'),
        },
        {
            code: "req.headers.get('x-real-ip')",
            errors: reported('x-real-ip'),
        },
        {
            code: "req.headers.get('x-forwarded-for')?.split(',')[0]",
            errors: reported('x-forwarded-for'),
        },
        // Case-insensitive: header names are.
        {
            code: "req.headers.get('X-Forwarded-For')",
            errors: reported('X-Forwarded-For'),
        },
        // Names smuggled through a list, a property access or a template.
        {
            code: "for (const name of ['x-real-ip', 'x-forwarded-for']) headers.get(name)",
            errors: [...reported('x-real-ip'), ...reported('x-forwarded-for')],
        },
        {
            code: "const ip = headers['x-real-ip']",
            errors: reported('x-real-ip'),
        },
        {
            code: 'headers.get(`x-real-ip`)',
            errors: reported('x-real-ip'),
        },
    ],
})

describe('the root eslint config', () => {
    const repoRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../..',
    )
    const appDir = path.join(repoRoot, 'apps/caramel-app')
    const RULE_ID = 'caramel/no-raw-client-ip-header'
    // Plain JS on purpose (see no-insensitive-prisma-literal-match.test.mjs).
    const code = "export const ip = h => h.get('x-real-ip')"

    const ruleIdsFor = (cwd, file) =>
        new Linter({ cwd })
            .verify(code, rootConfig, path.join(repoRoot, file))
            .map(message => message.ruleId)

    // Loaded from the repo root (husky lint-staged) and from apps/caramel-app
    // (`pnpm lint`, CI), like the Prisma ban's checks.
    for (const [name, cwd] of [
        ['repo root (husky lint-staged)', repoRoot],
        ['apps/caramel-app (pnpm lint, CI)', appDir],
    ]) {
        describe(`loaded from ${name}`, () => {
            it('bans the raw header in app source', () => {
                assert.deepEqual(
                    ruleIdsFor(cwd, 'apps/caramel-app/src/lib/other.ts'),
                    [RULE_ID],
                )
            })

            it('leaves the helper itself alone', () => {
                assert.deepEqual(
                    ruleIdsFor(cwd, 'apps/caramel-app/src/lib/clientIp.ts'),
                    [],
                )
            })

            it('exempts the OAuth redirect route until PR #321 lands (dated TODO in the config)', () => {
                assert.deepEqual(
                    ruleIdsFor(
                        cwd,
                        'apps/caramel-app/src/app/api/extension/oauth/redirect/route.ts',
                    ),
                    [],
                )
            })
        })
    }
})
