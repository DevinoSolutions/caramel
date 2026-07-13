import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// F-006 (plan step 8) — "rules become checks": fs-walks the app AND the
// extension for the 4 distinctive raw coupon-status tokens (and the
// `status IN (` predicate shape) reappearing outside the coupon-domain
// module, its generated extension mirror, or test files. A red run here
// means someone re-declared part of the vocabulary inline instead of
// importing lib/coupons.ts (app) / window.CaramelCoupons (extension) —
// exactly the drift F-006 exists to prevent from recurring. Bare 'valid'
// is deliberately NOT banned (too common a token — discount_type/other
// unrelated matches — to police without false positives); the 4 chosen
// tokens are distinctive enough to never appear for any other reason.

const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
)
const APP_SRC_DIR = path.join(REPO_ROOT, 'apps/caramel-app/src')
const EXT_DIR = path.join(REPO_ROOT, 'apps/caramel-extension')

const BANNED_TOKENS = [
    'valid_with_warning',
    'product_restriction',
    'category_restricted',
    'seller_specific',
    'status IN (',
]

const ALLOWLISTED_BASENAMES = new Set([
    'coupons.ts', // the domain module itself — the vocabulary's one legitimate home
    'coupon-constants.generated.js', // its committed extension mirror (F-006 step 6)
])

// Known, deliberately-LOCAL exceptions — NOT part of the shared status
// vocabulary (label + tier + visible/restricted) this gate protects, so
// centralizing them would not remove any duplication (nothing to unify
// against). Each is commented at its own definition site explaining why.
// Keyed narrowly (exact file + exact token) so any OTHER token, or this
// token anywhere else, still fails the gate.
const ALLOWLISTED_OCCURRENCES = new Set([
    // popup.js's restriction-detail SENTENCE per status (e.g. "Only for
    // items from a specific seller", shown in the warning banner) is
    // popup-only presentation copy with no app-side equivalent to drift
    // against — coupon-card.tsx shows the server-provided
    // verificationMessage instead, never a hard-coded per-status sentence.
    // Distinct from (and pre-dates) RESTRICTED_STATUSES / STATUS_META,
    // both of which this gate DOES cover via the F-006 rebind. See
    // PLAN-F-006.md's "Domain vs presentation" note.
    'popup.js::valid_with_warning',
    'popup.js::category_restricted',
    'popup.js::seller_specific',
])

function isAllowlistedFile(filePath: string): boolean {
    const base = path.basename(filePath)
    if (ALLOWLISTED_BASENAMES.has(base)) return true
    return base.endsWith('.test.ts') || base.endsWith('.test.mjs')
}

const SKIP_DIR_NAMES = new Set([
    'node_modules',
    '.next',
    'dist',
    '.git',
    'coverage',
])

function walk(dir: string, extensions: string[]): string[] {
    if (!fs.existsSync(dir)) return []
    const found: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIR_NAMES.has(entry.name)) continue
            found.push(...walk(path.join(dir, entry.name), extensions))
        } else if (extensions.some(ext => entry.name.endsWith(ext))) {
            found.push(path.join(dir, entry.name))
        }
    }
    return found
}

interface Violation {
    file: string
    token: string
}

function findViolations(files: string[]): Violation[] {
    const violations: Violation[] = []
    for (const file of files) {
        if (isAllowlistedFile(file)) continue
        const base = path.basename(file)
        const content = fs.readFileSync(file, 'utf8')
        for (const token of BANNED_TOKENS) {
            if (!content.includes(token)) continue
            if (ALLOWLISTED_OCCURRENCES.has(`${base}::${token}`)) continue
            violations.push({ file: path.relative(REPO_ROOT, file), token })
        }
    }
    return violations
}

describe('no-raw-coupon-status (F-006 ban gate)', () => {
    it('app src/ has no raw status literal / status IN ( outside lib/coupons.ts or *.test.ts', () => {
        const files = walk(APP_SRC_DIR, ['.ts', '.tsx'])
        expect(files.length).toBeGreaterThan(0) // sanity: the walk actually found files
        expect(findViolations(files)).toEqual([])
    })

    it('extension has no raw status literal / status IN ( outside coupon-constants.generated.js, *.test.mjs, or the documented popup.js exception', () => {
        const files = walk(EXT_DIR, ['.js', '.mjs'])
        expect(files.length).toBeGreaterThan(0) // sanity: the walk actually found files
        expect(findViolations(files)).toEqual([])
    })
})
