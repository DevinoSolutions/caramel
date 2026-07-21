import { SERVER_ENV_KEYS, parseServerEnv } from '@/lib/env'
import { BASE_URL, CLIENT_ENV_KEYS, parseClientEnv } from '@/lib/env.client'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// F-005 pins — zod-validated env contract. Relocated per CR-1 (co-located
// src/lib/env.test.ts in the plan -> tests/unit/, content unchanged).
//
// The eager singletons (`env`, `clientEnv`, `BASE_URL`) are exercised
// indirectly everywhere they're imported; these tests target the pure
// `parseServerEnv`/`parseClientEnv` functions directly so bad fixtures can
// be exercised without mutating process.env (see vitest.config.ts `test.env`
// for how the eager singletons stay safe to import during the whole suite).

const validServerFixture = {
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:58005/caramel',
    COUPONS_DATABASE_URL:
        'postgresql://postgres:postgres@localhost:58005/caramel_coupons',
    BETTER_AUTH_SECRET: 'test-better-auth-secret',
}

describe('parseServerEnv', () => {
    it('(a) valid fixture parses to a typed object', () => {
        const parsed = parseServerEnv(validServerFixture)
        expect(parsed.DATABASE_URL).toBe(validServerFixture.DATABASE_URL)
        expect(parsed.COUPONS_DATABASE_URL).toBe(
            validServerFixture.COUPONS_DATABASE_URL,
        )
        expect(parsed.BETTER_AUTH_SECRET).toBe(
            validServerFixture.BETTER_AUTH_SECRET,
        )
    })

    it('(b) missing DATABASE_URL throws, naming DATABASE_URL', () => {
        const { DATABASE_URL: _omit, ...rest } = validServerFixture
        expect(() => parseServerEnv(rest)).toThrow(/DATABASE_URL/)
    })

    it('(c) COUPONS_DATABASE_URL is OPTIONAL — absent still parses (W4-D3: bridge-sync is opt-in, the app serves its own catalog)', () => {
        const { COUPONS_DATABASE_URL: _omit, ...rest } = validServerFixture
        const parsed = parseServerEnv(rest)
        expect(parsed.COUPONS_DATABASE_URL).toBeUndefined()
    })

    it('(d) both auth secrets absent throws, naming BETTER_AUTH_SECRET and JWT_SECRET', () => {
        const { BETTER_AUTH_SECRET: _omit, ...rest } = validServerFixture
        expect(() => parseServerEnv(rest)).toThrow(/BETTER_AUTH_SECRET/)
        expect(() => parseServerEnv(rest)).toThrow(/JWT_SECRET/)
    })

    it('(d.1) JWT_SECRET alone (no BETTER_AUTH_SECRET) satisfies the requirement', () => {
        const { BETTER_AUTH_SECRET: _omit, ...rest } = validServerFixture
        expect(() =>
            parseServerEnv({ ...rest, JWT_SECRET: 'test-jwt-secret' }),
        ).not.toThrow()
    })

    it('(e) optional vars absent succeed with schema defaults', () => {
        const parsed = parseServerEnv(validServerFixture)
        expect(parsed.BCRYPT_SALT_ROUNDS).toBe(10)
        expect(parsed.OPENROUTER_MODEL).toBe('openai/gpt-5-mini')
        expect(parsed.ALLOWED_ORIGINS).toBe('')
        expect(parsed.USESEND_FROM_EMAIL).toBe('no_reply@grabcaramel.com')
        expect(parsed.USESEND_FROM_NAME).toBe('Caramel')
        expect(parsed.GOOGLE_CLIENT_ID).toBeUndefined()
    })

    it('(g) POSTHOG_DATASET defaults to disabled and accepts the enum', () => {
        expect(parseServerEnv(validServerFixture).POSTHOG_DATASET).toBe(
            'disabled',
        )
        expect(
            parseServerEnv({
                ...validServerFixture,
                POSTHOG_DATASET: 'production',
            }).POSTHOG_DATASET,
        ).toBe('production')
    })

    it('(g) server + client dataset disagreement (both set) throws', () => {
        expect(() =>
            parseServerEnv({
                ...validServerFixture,
                POSTHOG_DATASET: 'production',
                NEXT_PUBLIC_POSTHOG_DATASET: 'e2e',
            }),
        ).toThrow(/disagree/)
    })

    it('(g) matching server + client datasets parse fine', () => {
        expect(() =>
            parseServerEnv({
                ...validServerFixture,
                POSTHOG_DATASET: 'e2e',
                NEXT_PUBLIC_POSTHOG_DATASET: 'e2e',
            }),
        ).not.toThrow()
    })

    it('(g) the Playwright/CI-only read key present in app env throws (key hygiene)', () => {
        expect(() =>
            parseServerEnv({
                ...validServerFixture,
                POSTHOG_E2E_TEST_PROJECT_QUERY_READ_ONLY_PERSONAL_API_KEY:
                    'phx_should_not_be_here',
            }),
        ).toThrow(/POSTHOG_E2E_TEST_PROJECT_QUERY_READ_ONLY_PERSONAL_API_KEY/)
    })
})

describe('parseClientEnv', () => {
    it('(f) never throws on empty input', () => {
        expect(() => parseClientEnv({})).not.toThrow()
        expect(parseClientEnv({}).NEXT_PUBLIC_BASE_URL).toBeUndefined()
    })

    it('(f) BASE_URL fallback formula: unset -> prod URL, set -> the value', () => {
        const unset =
            parseClientEnv({}).NEXT_PUBLIC_BASE_URL ?? 'https://grabcaramel.com'
        expect(unset).toBe('https://grabcaramel.com')

        const set =
            parseClientEnv({ NEXT_PUBLIC_BASE_URL: 'http://localhost:58000' })
                .NEXT_PUBLIC_BASE_URL ?? 'https://grabcaramel.com'
        expect(set).toBe('http://localhost:58000')
    })

    it('(f) the BASE_URL singleton falls back to the prod URL (NEXT_PUBLIC_BASE_URL unset in test.env)', () => {
        expect(BASE_URL).toBe('https://grabcaramel.com')
    })

    it('(g) empty input defaults NEXT_PUBLIC_POSTHOG_DATASET to disabled', () => {
        expect(parseClientEnv({}).NEXT_PUBLIC_POSTHOG_DATASET).toBe('disabled')
    })

    it('(g) production dataset WITHOUT its capture pair throws (strict parse)', () => {
        expect(() =>
            parseClientEnv({ NEXT_PUBLIC_POSTHOG_DATASET: 'production' }),
        ).toThrow(/NEXT_PUBLIC_POSTHOG_KEY/)
    })

    it('(g) e2e dataset WITHOUT its capture pair throws (strict parse)', () => {
        expect(() =>
            parseClientEnv({ NEXT_PUBLIC_POSTHOG_DATASET: 'e2e' }),
        ).toThrow(/NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_CAPTURE_TOKEN/)
    })

    it('(g) production dataset WITH its capture pair parses', () => {
        expect(() =>
            parseClientEnv({
                NEXT_PUBLIC_POSTHOG_DATASET: 'production',
                NEXT_PUBLIC_POSTHOG_HOST: 'https://posthog.devino.ca',
                NEXT_PUBLIC_POSTHOG_KEY: 'phc_prod',
            }),
        ).not.toThrow()
    })
})

describe('.env.example drift', () => {
    it('documents every server + client schema key (prevents future staleness)', () => {
        const testDir = path.dirname(fileURLToPath(import.meta.url))
        const envExamplePath = path.resolve(testDir, '../../.env.example')
        const content = fs.readFileSync(envExamplePath, 'utf8')
        const documentedKeys = new Set(
            content
                .split('\n')
                .map(line => line.trim())
                // A commented-out assignment ("# KEY=value") still DOCUMENTS
                // the key: .env.example deliberately ships the optional
                // COUPONS_DATABASE_URL commented out (bridge-sync-only input;
                // a set-but-EMPTY value fails env.ts's `.min(1)` at boot, so
                // the template must not ship it active). Prose comments don't
                // match the KEY= shape and stay excluded.
                .map(line => line.replace(/^#\s*(?=[A-Z][A-Z0-9_]*=)/, ''))
                .filter(line => line && !line.startsWith('#'))
                .map(line => line.split('=')[0]?.trim())
                .filter((key): key is string => Boolean(key)),
        )

        for (const key of [...SERVER_ENV_KEYS, ...CLIENT_ENV_KEYS]) {
            expect(
                documentedKeys.has(key),
                `${key} is in the env schema but missing from .env.example`,
            ).toBe(true)
        }
    })
})
