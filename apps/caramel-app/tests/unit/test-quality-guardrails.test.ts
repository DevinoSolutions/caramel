import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Test-quality guardrails ("rules become checks", CLAUDE.md) — two flakiness/focus
// hazards a grep can catch at commit/CI time across every suite in both
// packages:
//
//  (1) NO `.only(` anywhere under tests/** or e2e/**. A committed `.only`
//      silently narrows a suite to one focused case — CI goes green while
//      most tests never run. Playwright already sets `forbidOnly` at e2e
//      RUNTIME (playwright.config.ts); this extends the ban to the unit +
//      extension suites and catches it statically, before any run.
//  (2) NO wall-clock sleeps in e2e specs — `page.waitForTimeout(`, or a
//      `setTimeout`-as-sleep (incl. `new Promise(r => setTimeout(...))`).
//      They trade determinism for a fixed guess and are the classic source
//      of flaky/slow e2e. Scoped to e2e/** ONLY: unit tests may legitimately
//      drive fake timers / real setTimeout, so they are never scanned here.
//
// This gate's OWN file is allowlisted from the scan — it necessarily contains
// the banned patterns as detector fixtures/regexes. Its correctness is proven
// by the red-proof `it` below, which feeds each detector a violation assembled
// at runtime so the literal token never appears in this file's source.

const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
)
const APP_DIR = path.join(REPO_ROOT, 'apps/caramel-app')
const EXT_DIR = path.join(REPO_ROOT, 'apps/caramel-extension')

const SELF_BASENAME = 'test-quality-guardrails.test.ts'
const TEST_EXTS = ['.ts', '.tsx', '.mjs', '.js']
const SKIP_DIR_NAMES = new Set([
    'node_modules',
    '.next',
    'dist',
    '.git',
    'coverage',
])

// `.only` is scanned across every test tree in both packages.
const ONLY_SCAN_DIRS = [
    path.join(APP_DIR, 'tests'),
    path.join(APP_DIR, 'e2e'),
    path.join(EXT_DIR, 'tests'),
]
// Sleeps are scanned in e2e specs only.
const SLEEP_SCAN_DIRS = [path.join(APP_DIR, 'e2e')]

function walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    const found: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIR_NAMES.has(entry.name)) continue
            found.push(...walk(path.join(dir, entry.name)))
        } else if (
            entry.name !== SELF_BASENAME &&
            TEST_EXTS.some(ext => entry.name.endsWith(ext))
        ) {
            found.push(path.join(dir, entry.name))
        }
    }
    return found
}

function relToRepo(file: string): string {
    return path.relative(REPO_ROOT, file).split(path.sep).join('/')
}

// A focused-test modifier: `it.only(`, `test.only(`, `describe.only(`,
// `test.describe.only(`, etc. Anchored to a test keyword so an unrelated
// `.only(` (there is no such API on arrays/strings) can't false-positive.
const ONLY_RE = /(?:describe|it|test|bench|suite)(?:\.\w+)*\.only\s*\(/

const SLEEP_MATCHERS: { name: string; re: RegExp }[] = [
    { name: 'page.waitForTimeout', re: /\.waitForTimeout\s*\(/ },
    // catches a bare `setTimeout(` AND `new Promise(r => setTimeout(...))`.
    { name: 'setTimeout', re: /\bsetTimeout\s*\(/ },
]

function hasOnly(content: string): boolean {
    return ONLY_RE.test(content)
}

function matchSleep(content: string): string | null {
    return SLEEP_MATCHERS.find(m => m.re.test(content))?.name ?? null
}

/* These two walk and read every test file in the repo, synchronously, and their
 * cost grows with the suite they police. Vitest's 5s default is sized for unit
 * work: on 2026-08-06 the extension suite crossed 400 tests and this gate went
 * red inside the full run while passing on its own — a guardrail that fails for
 * reasons unrelated to what it guards is a guardrail people start ignoring. The
 * work is bounded and IO-only, so the budget is generous on purpose. */
const SCAN_TIMEOUT_MS = 30000

describe('test-quality-guardrails (rules become checks)', () => {
    it(
        'no `.only(` under tests/** or e2e/** in either package',
        () => {
            const files = ONLY_SCAN_DIRS.flatMap(walk)
            expect(files.length).toBeGreaterThan(0) // sanity: the walk found tests
            const offenders = files
                .filter(file => hasOnly(fs.readFileSync(file, 'utf8')))
                .map(relToRepo)
            expect(offenders).toEqual([])
        },
        SCAN_TIMEOUT_MS,
    )

    it(
        'no wall-clock sleeps (waitForTimeout / setTimeout) in e2e specs',
        () => {
            const files = SLEEP_SCAN_DIRS.flatMap(walk)
            expect(files.length).toBeGreaterThan(0) // sanity: the walk found specs
            const offenders = files
                .map(file => ({
                    file: relToRepo(file),
                    kind: matchSleep(fs.readFileSync(file, 'utf8')),
                }))
                .filter(o => o.kind !== null)
            expect(offenders).toEqual([])
        },
        SCAN_TIMEOUT_MS,
    )

    it('the detectors catch a focused test and e2e sleeps (red-proof)', () => {
        // Tokens are assembled at runtime (split so the literal banned pattern
        // never appears in this file's own source) — the detectors must fire
        // on the reconstructed strings.
        expect(hasOnly(['it', '.only', "('x', () => {})"].join(''))).toBe(true)
        expect(hasOnly(['test.describe', '.only', '('].join(''))).toBe(true)
        expect(hasOnly('expect(page).toHaveURL(/x/)')).toBe(false)

        expect(
            matchSleep(['await page.', 'waitForTimeout(500)'].join('')),
        ).toBe('page.waitForTimeout')
        expect(
            matchSleep(
                ['await new Promise(r => set', 'Timeout(r, 75))'].join(''),
            ),
        ).toBe('setTimeout')
        expect(matchSleep('await page.waitForSelector(".ready")')).toBeNull()
    })
})
