import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// T-8622: vitest.config.ts pins TZ=UTC in the main process. This is the proof
// it reached the worker (a shell-exported TZ, or a config regression to
// `test.env`, which threads ignore, would fail here instead of surfacing as a
// date that is off by a day in some unrelated suite).
describe('test runner timezone pin', () => {
    it('runs every suite in UTC', () => {
        expect(process.env.TZ).toBe('UTC')
        expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC')
        expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(0)
        expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(0)
    })

    it('reads local-time getters as UTC', () => {
        const date = new Date('2026-09-24T23:30:00Z')

        expect(date.getHours()).toBe(23)
        expect(date.getDate()).toBe(24)
        expect(date.toString()).toContain('GMT+0000')
    })
})

// T-9177: the in-process test above only proves the unit config. This guard
// makes the pin a rule for every vitest config in the package, so a new or
// edited config (eval, integration, drift, ...) cannot silently drop it.
const TZ_PIN = "process.env.TZ = 'UTC'"

// Comments are stripped first so a commented-out pin does not count.
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('vitest configs pin the timezone', () => {
    const packageRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../..',
    )
    const configFiles = fs
        .readdirSync(packageRoot)
        .filter(name => /^vitest.*\.config\.[cm]?[jt]s$/.test(name))

    it('finds the vitest configs', () => {
        expect(configFiles).toContain('vitest.config.ts')
    })

    it.each(configFiles)('%s pins TZ=UTC in code', name => {
        const code = stripComments(
            fs.readFileSync(path.join(packageRoot, name), 'utf8'),
        )

        expect(code).toContain(TZ_PIN)
    })

    // loadEnvFile never overrides a var already set, so the pin only beats a
    // TZ in .env when it runs first.
    it.each(configFiles)('%s pins TZ before loadEnvFile', name => {
        const code = stripComments(
            fs.readFileSync(path.join(packageRoot, name), 'utf8'),
        )
        const loadIndex = code.indexOf('loadEnvFile(')

        if (loadIndex === -1) return
        expect(code.indexOf(TZ_PIN)).toBeGreaterThanOrEqual(0)
        expect(code.indexOf(TZ_PIN)).toBeLessThan(loadIndex)
    })
})
