import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Secrecy forward-rule — INVERTED at W3a of the Coupons Ownership Inversion.
//
// BEFORE W3a the app modelled NONE of the coupon catalog: coupons / sources /
// verification_* were ALL the external Python service's, and this gate banned
// every one of them (plus any Coupon*/Source*/Verification* model NAME).
//
// W3a moves ownership of the PUBLISHED catalog — the coupon rows, the source
// list, and the flattened per-store apply config — INTO this app's Postgres, so
// schema.prisma now LEGITIMATELY declares:
//   - model Coupon      @@map("coupons")
//   - model Source      @@map("sources")
//   - model StoreConfig @@map("store_configs")
//   - Coupon.verificationMessage @map("verification_message")   (catalog column)
// alongside the pre-existing CouponSignal (@@map coupon_signals, W1 telemetry)
// and better-auth's Verification (@@map verification_tokens). The old model-NAME
// ban is therefore GONE — the app may name these models whatever it wants.
//
// What stays SECRET — and what this gate now protects — is the scraper's
// PIPELINE-INTERNAL machinery that the Python service still owns and that must
// NEVER be modelled here: the verification pipeline's own tables
// (verification_stores, store_verification_configs, verification_configs,
// verification_runs, …) and any agent_*/scraper_* run state. The published
// StoreConfig is the FLATTENED shape (store_name + 8 xpaths + `origin`, who
// wrote the row: NULL = the pipeline, 'auto_detect' = the extension's save);
// the internal `verification_stores` ⋈ `store_verification_configs` join that PRODUCES it is
// exactly what may not leak.
//
// The gate is therefore MAP-TARGET based (real DB table/column names), not
// model-name based: it fails if any @@map/@map targets a pipeline-internal
// table. The ONLY allowed `verification*` targets are `verification_message`
// (the catalog column) and `verification_tokens` (auth) — every other
// `verification_*`, the non-prefixed `store_verification_configs`, and any
// `agent_*`/`scraper_*` target is a leak and fails the build.
//
// Scope is schema.prisma ALONE (the migrations/ Coupon/Source residual is
// CTO-accepted, DESIGN.md §3 "Historical residual", and not scanned).
//
// TODO(W5): DESIGN.md §2(k) + CLAUDE.md still carry the PRE-W3a prose ("No
// coupons/sources/verification_* schema in prisma/schema.prisma, ever"). W5
// rewrites that prose to match this inversion; until then THIS test is the
// authoritative statement of the boundary.

const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
)
const SCHEMA_PATH = path.join(
    REPO_ROOT,
    'apps/caramel-app/prisma/schema.prisma',
)

// The ONLY `verification*` map targets the app may own: the catalog column on
// Coupon (verification_message) and better-auth's token table
// (verification_tokens). Everything else in the verification_* family is the
// scraper pipeline's and must not be modelled here.
const ALLOWLISTED_MAP_TARGETS = new Set([
    'verification_tokens',
    'verification_message',
])

// Pipeline-internal tables that do NOT carry the `verification_` prefix but are
// still the scraper's private machinery (the join that produces the published
// StoreConfig). Named explicitly because the prefix rule below can't see them —
// and note this is `store_verification_configs`, distinct from the app-owned
// `store_configs`.
const BANNED_EXACT_TARGETS = new Set(['store_verification_configs'])

// A @@map/@map target is a coupons-DB secrecy leak iff it names the scraper's
// pipeline-internal state. Allowlist wins first (the two legit verification*
// targets), then the explicit non-prefixed internals, then the prefix families.
function isBannedMapTarget(target: string): boolean {
    if (ALLOWLISTED_MAP_TARGETS.has(target)) return false
    if (BANNED_EXACT_TARGETS.has(target)) return true
    return (
        target.startsWith('verification_') ||
        target.startsWith('agent_') ||
        target.startsWith('scraper_')
    )
}

interface SchemaViolation {
    kind: 'map'
    name: string
}

// Pure detector over Prisma DSL text: every @@map("table") / @map("column")
// target that names pipeline-internal state. Model/enum NAMES are no longer
// scanned — post-inversion the app owns Coupon/Source/StoreConfig, and the real
// secrecy signal is the DB identifier a model maps ONTO, not its Prisma name.
function findBannedSchemaEntities(schema: string): SchemaViolation[] {
    const violations: SchemaViolation[] = []

    const mapRe = /@@?map\(\s*["']([^"']+)["']\s*\)/g
    for (const match of Array.from(schema.matchAll(mapRe))) {
        const target = match[1]!
        if (isBannedMapTarget(target)) {
            violations.push({ kind: 'map', name: target })
        }
    }

    return violations
}

describe('prisma-schema-secrecy (DESIGN §2(k) forward-rule, W3a-inverted)', () => {
    it('schema.prisma maps no pipeline-internal coupons-DB table', () => {
        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8')
        expect(findBannedSchemaEntities(schema)).toEqual([])
    })

    it('allowlists better-auth Verification → verification_tokens by MATCHING it, not by its absence', () => {
        // Sanity that the file actually contains the one allowlisted auth
        // token table — so the green result above is the allowlist doing its
        // job, not the file simply lacking any Verification entity (which would
        // let the allowlist rot silently).
        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8')
        expect(schema).toMatch(/\bmodel\s+Verification\b/)
        expect(schema).toMatch(/@@map\("verification_tokens"\)/)
    })

    it('allowlists the app-owned published catalog (Coupon/Source/StoreConfig + verification_message) by MATCHING it, not by its absence', () => {
        // "Match, not absence": the schema really declares the W3a catalog
        // (mapped to the once-banned coupons/sources tables + the
        // verification_message column) and the W1 CouponSignal telemetry — so
        // the green result above is the inverted rule ALLOWING owned tables,
        // not those models being missing.
        const schema = fs.readFileSync(SCHEMA_PATH, 'utf8')
        expect(schema).toMatch(/\bmodel\s+Coupon\b/)
        expect(schema).toMatch(/@@map\("coupons"\)/)
        expect(schema).toMatch(/\bmodel\s+Source\b/)
        expect(schema).toMatch(/@@map\("sources"\)/)
        expect(schema).toMatch(/\bmodel\s+StoreConfig\b/)
        expect(schema).toMatch(/@@map\("store_configs"\)/)
        expect(schema).toMatch(/\borigin\s+String\?\s+@map\("origin"\)/)
        expect(schema).toMatch(/@map\("verification_message"\)/)
        expect(schema).toMatch(/\bmodel\s+CouponSignal\b/)
        expect(schema).toMatch(/@@map\("coupon_signals"\)/)

        // And none of those owned map targets is flagged — the whole point of
        // the inversion.
        expect(findBannedSchemaEntities(schema)).toEqual([])
    })

    it('STILL catches a pipeline-internal schema leak while leaving the app-owned catalog alone (red-proof)', () => {
        const leak = [
            // App-owned + allowlisted — must NOT be flagged.
            'model Coupon {',
            '  id String @id',
            '  vm String? @map("verification_message")',
            '  @@map("coupons")',
            '}',
            'model StoreConfig {',
            '  storeName String @id @map("store_name")',
            '  @@map("store_configs")',
            '}',
            // Pipeline-internal machinery — every one MUST be flagged.
            'model StoreVerificationConfig {',
            '  id String @id',
            '  @@map("store_verification_configs")', // non-prefixed internal
            '}',
            'model VerificationStore {',
            '  id String @id',
            '  @@map("verification_stores")',
            '}',
            'model VerificationConfig {',
            '  id String @id',
            '  @@map("verification_configs")',
            '}',
            'model VerificationRun {',
            '  id String @id',
            '  @@map("verification_runs")',
            '}',
            'model AgentRun {',
            '  id String @id',
            '  @@map("agent_runs")',
            '}',
            'model ScraperJob {',
            '  id String @id',
            '  @@map("scraper_jobs")',
            '}',
        ].join('\n')

        const names = findBannedSchemaEntities(leak)
            .map(v => v.name)
            .sort()
        expect(names).toEqual(
            [
                'store_verification_configs',
                'verification_stores',
                'verification_configs',
                'verification_runs',
                'agent_runs',
                'scraper_jobs',
            ].sort(),
        )
        // Surgical: the app-owned coupons/store_configs and the
        // verification_message column are absent from the flagged set.
        expect(names).not.toContain('coupons')
        expect(names).not.toContain('store_configs')
        expect(names).not.toContain('verification_message')
    })

    it('does NOT flag the legitimate auth + app-owned catalog models', () => {
        const legitSchema = [
            'model Account { id String @id @@map("accounts") }',
            'model Session { id String @id @@map("sessions") }',
            'model Verification { id String @id @@map("verification_tokens") }',
            'model User { id String @id @@map("users") }',
            'model CouponSignal { id String @id @map("coupon_id") @@map("coupon_signals") }',
            'model Coupon { id String @id vm String? @map("verification_message") @@map("coupons") }',
            'model Source { id String @id @@map("sources") }',
            'model StoreConfig { id String @id @map("store_name") @@map("store_configs") }',
            'enum Role { USER ADMIN }',
            'enum UserStatus { ACTIVE_USER NOT_VERIFIED }',
        ].join('\n')
        expect(findBannedSchemaEntities(legitSchema)).toEqual([])
    })
})
