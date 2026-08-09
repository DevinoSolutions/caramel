// src/lib/profile/accountExport.ts
//
// Builds the "download my data" JSON, and enforces what may never be in it.
//
// This file is deliberately a pure builder plus a guard, with no Prisma and no
// HTTP: the route fetches rows, this shapes them, and the same guard the route
// runs is what the unit test asserts. A leak here is a privacy breach in a
// PUBLIC repo, so the never-include list is a CHECK that fails the request,
// not a comment that asks the next author to be careful.
//
// NEVER in the export:
//   - password hashes / any credential material
//   - session or bearer tokens, OAuth access/refresh tokens, verification
//     tokens
//   - any other user's identifiers
//   - internal catalog row ids (a coupon's primary key tells the user nothing
//     and hands out our catalog's internal keyspace)
//
// The export therefore names a coupon by the STORE and CODE the user actually
// saw, never by `couponId`. Adding a field to this file means adding it to the
// contract; adding a forbidden one makes the request throw.

/** Key names that must never appear anywhere in an export payload, at any
 * depth. Compared case-insensitively so `passwordHash` and `PasswordHash` are
 * both caught. */
export const FORBIDDEN_EXPORT_KEYS: readonly string[] = [
    'password',
    'passwordhash',
    'hash',
    'salt',
    'token',
    'tokenexpiry',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'sessiontoken',
    'secret',
    'apikey',
    'couponid',
    'userid',
    'id_token',
    'access_token',
    'refresh_token',
]

/** Keys that are legitimately named `id` but are the user's OWN account id —
 * the one identifier a data export is supposed to contain. */
const ALLOWED_ID_PATHS = new Set(['account.id'])

export interface AccountExport {
    /** ISO — when this file was produced. */
    exportedAt: string
    account: {
        id: string
        email: string | null
        name: string | null
        firstName: string | null
        lastName: string | null
        username: string | null
        createdAt: string
        emailVerified: boolean
    }
    preferences: {
        savingsSyncEnabled: boolean
    }
    favoriteStores: { domain: string; starredAt: string }[]
    savingsEvents: {
        storeDomain: string
        code: string | null
        amountMinorUnits: number
        currency: string
        occurredAt: string
    }[]
    couponReports: {
        storeDomain: string | null
        code: string | null
        outcome: string
        reportedAt: string
    }[]
}

/**
 * Walks a payload and returns the dotted paths of every key that violates the
 * never-include list. Empty array = clean.
 *
 * Array indices collapse to `[]` so a 400-event export reports
 * `savingsEvents[].couponId` once rather than 400 times.
 */
export function collectForbiddenKeys(value: unknown, path = ''): string[] {
    if (Array.isArray(value)) {
        const found = new Set<string>()
        for (const item of value) {
            for (const hit of collectForbiddenKeys(item, `${path}[]`)) {
                found.add(hit)
            }
        }
        return Array.from(found)
    }
    if (value === null || typeof value !== 'object') return []

    const hits: string[] = []
    for (const [key, child] of Object.entries(
        value as Record<string, unknown>,
    )) {
        const childPath = path ? `${path}.${key}` : key
        const normalized = key.toLowerCase()
        const isForbidden =
            FORBIDDEN_EXPORT_KEYS.includes(normalized) ||
            (normalized === 'id' && !ALLOWED_ID_PATHS.has(childPath))
        if (isForbidden) hits.push(childPath)
        hits.push(...collectForbiddenKeys(child, childPath))
    }
    return hits
}

/**
 * The guard the export route runs on every response before it is serialized.
 *
 * Throwing (rather than stripping) is the point: a silently-stripped field
 * would let a leak sit in the builder unnoticed until the strip list drifted.
 * withRoute's try/catch turns this into a 500 + Sentry, which is the correct
 * outcome for "we were about to hand someone data we promised never to send".
 */
export function assertExportIsSafe(payload: AccountExport): void {
    const violations = collectForbiddenKeys(payload)
    if (violations.length > 0) {
        throw new Error(
            `Account export contains forbidden fields: ${violations.join(', ')}`,
        )
    }
}

export interface AccountExportInput {
    account: {
        id: string
        email: string | null
        name: string | null
        firstName: string | null
        lastName: string | null
        username: string | null
        createdAt: Date
        emailVerified: boolean
    }
    savingsSyncEnabled: boolean
    favoriteStores: { storeName: string; createdAt: Date }[]
    savingsEvents: {
        store: string
        code: string
        amountCents: number
        currency: string
        occurredAt: Date
    }[]
    couponReports: {
        outcome: string
        createdAt: Date
        coupon: { site: string | null; code: string } | null
    }[]
}

/**
 * Shapes fetched rows into the export contract.
 *
 * Note what is dropped on the way through: `SavingsEvent.id`,
 * `SavingsEvent.couponId`, `SavingsEvent.clientEventId`, `CouponReport.id`,
 * `CouponReport.couponId`, `FavoriteStore.userId` and `Coupon.id`. Every one
 * is an internal key that says nothing to the person reading their own data.
 */
export function buildAccountExport(
    input: AccountExportInput,
    now: Date = new Date(),
): AccountExport {
    return {
        exportedAt: now.toISOString(),
        account: {
            id: input.account.id,
            email: input.account.email,
            name: input.account.name,
            firstName: input.account.firstName,
            lastName: input.account.lastName,
            username: input.account.username,
            createdAt: input.account.createdAt.toISOString(),
            emailVerified: input.account.emailVerified,
        },
        preferences: {
            savingsSyncEnabled: input.savingsSyncEnabled,
        },
        favoriteStores: input.favoriteStores.map(row => ({
            domain: row.storeName,
            starredAt: row.createdAt.toISOString(),
        })),
        savingsEvents: input.savingsEvents.map(row => ({
            storeDomain: row.store,
            code: row.code === '' ? null : row.code,
            amountMinorUnits: row.amountCents,
            currency: row.currency,
            occurredAt: row.occurredAt.toISOString(),
        })),
        couponReports: input.couponReports.map(row => ({
            // Named by what the user saw, never by the catalog's row id.
            storeDomain: row.coupon?.site ?? null,
            code: row.coupon?.code ?? null,
            outcome: row.outcome,
            reportedAt: row.createdAt.toISOString(),
        })),
    }
}

/** `caramel-data-2026-08-09.json` — the filename the browser saves. */
export function exportFilename(now: Date = new Date()): string {
    return `caramel-data-${now.toISOString().slice(0, 10)}.json`
}
