import { parseServerEnv } from '@/lib/env'
import { buildProxyFallbackHeaders } from '@/lib/proxy-fallback-headers'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The paid-fallback env vars at the two boundaries that are not a request:
// the eval and e2e runners must blank them, and a malformed value must refuse
// boot without the value ever reaching an error or the console.

const TEST_FALLBACK_KEY = 'sk-or-v1-' + 'test000000000000000000000000'
const NAMES = [
    'OPENROUTER_FALLBACK_API_KEY',
    'OPENROUTER_FALLBACK_MODEL',
    'OPENROUTER_FALLBACK_AFTER_SECONDS',
] as const

afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
})

describe('paid-fallback settings outside a request', () => {
    it('the real eval config and the Playwright config blank all three vars, so a key in a shell or .env never reaches evals or e2e', async () => {
        vi.stubEnv('OPENROUTER_FALLBACK_API_KEY', TEST_FALLBACK_KEY)
        vi.stubEnv('OPENROUTER_FALLBACK_MODEL', 'vendor/test')
        vi.stubEnv('OPENROUTER_FALLBACK_AFTER_SECONDS', '9')
        vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {})
        const evalConfig = (await import('../../vitest.eval.config')).default
        const evalEnv = (
            evalConfig as unknown as {
                test?: { env?: Record<string, string> }
            }
        ).test?.env
        expect(evalEnv).toMatchObject({
            OPENROUTER_FALLBACK_API_KEY: '',
            OPENROUTER_FALLBACK_MODEL: '',
            OPENROUTER_FALLBACK_AFTER_SECONDS: '',
        })
        // vitest applies test.env OVER the inherited process env: a shell key
        // is overwritten by the blank, which the helper treats as unset.
        const evalProcessEnv = {
            OPENROUTER_FALLBACK_API_KEY: TEST_FALLBACK_KEY,
            ...evalEnv,
        }
        expect(
            buildProxyFallbackHeaders({
                baseUrl: 'https://proxyai.devino.ca/v1',
                key: evalProcessEnv.OPENROUTER_FALLBACK_API_KEY,
                model: undefined,
                afterSeconds: undefined,
            }),
        ).toEqual({})

        // Source pin: playwright.config.ts cannot be loaded in a unit test
        // (it starts a web server), so pin the blanking in its webServer env.
        // Read as code, not text: a comment or a string that merely mentions
        // `NAME: ''` must not satisfy this. The three blanks must be real
        // properties of the `env` object handed to the web server.
        const testDir = path.dirname(fileURLToPath(import.meta.url))
        const file = ts.createSourceFile(
            'playwright.config.ts',
            fs.readFileSync(
                path.resolve(testDir, '../../playwright.config.ts'),
                'utf8',
            ),
            ts.ScriptTarget.Latest,
        )
        const webServerEnvBlanks: string[][] = []
        const visit = (node: ts.Node): void => {
            if (
                ts.isPropertyAssignment(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === 'webServer' &&
                ts.isObjectLiteralExpression(node.initializer)
            ) {
                for (const property of node.initializer.properties) {
                    if (
                        ts.isPropertyAssignment(property) &&
                        ts.isIdentifier(property.name) &&
                        property.name.text === 'env' &&
                        ts.isObjectLiteralExpression(property.initializer)
                    ) {
                        const blanks = new Set<string>()
                        for (const entry of property.initializer.properties) {
                            if (
                                ts.isPropertyAssignment(entry) &&
                                ts.isIdentifier(entry.name) &&
                                ts.isStringLiteral(entry.initializer) &&
                                entry.initializer.text === ''
                            )
                                blanks.add(entry.name.text)
                        }
                        webServerEnvBlanks.push(
                            NAMES.filter(name => blanks.has(name)),
                        )
                    }
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(file)
        expect(webServerEnvBlanks).toEqual([[...NAMES]])
    })

    it('the env schema accepts them unset or blank, and refuses a malformed key, model or a wait over 12 seconds naming the variable but never printing the value', () => {
        const bootFixture = {
            DATABASE_URL:
                'postgresql://postgres:postgres@localhost:58005/caramel',
            BETTER_AUTH_SECRET: 'test-better-auth-secret',
        }
        expect(() => parseServerEnv(bootFixture)).not.toThrow()
        expect(() =>
            parseServerEnv({
                ...bootFixture,
                OPENROUTER_FALLBACK_API_KEY: '',
                OPENROUTER_FALLBACK_MODEL: '',
                OPENROUTER_FALLBACK_AFTER_SECONDS: '',
            }),
        ).not.toThrow()
        expect(
            parseServerEnv({
                ...bootFixture,
                OPENROUTER_FALLBACK_API_KEY: TEST_FALLBACK_KEY,
                OPENROUTER_FALLBACK_MODEL: 'deepseek/deepseek-v4.1-flash',
                OPENROUTER_FALLBACK_AFTER_SECONDS: '12',
            }).OPENROUTER_FALLBACK_AFTER_SECONDS,
        ).toBe('12')

        const sinks = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
            level => vi.spyOn(console, level).mockImplementation(() => {}),
        )
        for (const [name, value] of [
            [NAMES[0], 'sk-or-v1-SECRETVALUE\nwith-a-newline-000000'],
            [NAMES[0], 'sk-or-v1-BOOTLEAK!'],
            [NAMES[1], 'bad model'],
            [NAMES[2], '1e3'],
            [NAMES[2], '12.5'],
            [NAMES[2], '13'],
        ] as const) {
            let message = ''
            try {
                parseServerEnv({ ...bootFixture, [name]: value })
            } catch (e) {
                message = (e as Error).message
            }
            expect(message).toContain(name)
            expect(message).not.toContain(value)
            expect(
                JSON.stringify(sinks.map(sink => sink.mock.calls)),
            ).not.toContain(value)
        }
    })
})
