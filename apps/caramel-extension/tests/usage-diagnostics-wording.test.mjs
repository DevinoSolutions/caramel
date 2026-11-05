import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Usage diagnostics and the daily-active event are PSEUDONYMOUS: a random
// per-device id, with IP and user agent reaching server logs like every
// request. Review found "anonymous" overstating that, and these files are what
// the next card or policy sentence gets copied from, so the word is banned in
// them. "not anonymous" is the one allowed spelling. Other uses of the word in
// the extension (a public fetch with no bearer) are accurate and not listed.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = file => readFileSync(join(root, file), 'utf8')

const OVERSTATED =
    /(?<!not )anonym|(cannot|can't|can never|never) be (linked|joined)|unlinked|only analytics|identifies you/i

describe('usage diagnostics wording', () => {
    it.each([
        'entrypoints/popup/components/UsageDiagnosticsCard.tsx',
        'entrypoints/popup/views/SettingsView.tsx',
        'usage-diagnostics-consent.js',
        'extension-activity.js',
        'code-share-funnel.js',
        'code-capture.js',
        'caramel-base.js',
        'wxt.config.ts',
        'public/assets/styles.css',
    ])('%s does not overstate anonymity', file => {
        expect(read(file)).not.toMatch(OVERSTATED)
    })

    it("background.js's diagnostics path does not overstate anonymity", () => {
        const source = read('background.js')
        const start = source.indexOf('code-share funnel diagnostics')
        const end = source.indexOf('async function postUsageDiagnostic')
        expect(start).toBeGreaterThan(-1)
        expect(end).toBeGreaterThan(start)
        expect(source.slice(start, end)).not.toMatch(OVERSTATED)
        // The withdrawal path promises what we do, not what is impossible.
        expect(source).not.toMatch(/cannot be joined/i)
    })

    it('the consent card says pseudonymous', () => {
        expect(
            read('entrypoints/popup/components/UsageDiagnosticsCard.tsx'),
        ).toContain('Send pseudonymous diagnostics')
    })
})
