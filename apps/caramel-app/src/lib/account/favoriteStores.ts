// src/lib/account/favoriteStores.ts
//
// The one read/write path for `favorite_stores` — "the stores you follow".
//
// STORE KEY VOCABULARY (the reason this module exists rather than three
// inline Prisma calls). `FavoriteStore.storeName` is not free text: it is the
// REGISTRABLE base domain that `resolveStoreDomain()` produces — lowercase,
// `www.`/subdomains stripped, resolved against the Public Suffix List, so
// `www.nike.com`, `shop.nike.com` and `https://nike.com/cart` all key the same
// row. That is deliberately the SAME vocabulary as:
//
//   - `store_configs.store_name` (the published apply-config; its seed rows are
//     'ebay.com', 'amazon.com', 'codecademy.com') — joins on equality;
//   - the catalog's `coupons.site`, which listStoreCoupons() matches with
//     `site = <key> OR site LIKE '%.' || <key>` (a store's coupons are filed
//     under any of its hostnames);
//   - the `/coupons/[store]` URL, whose canonical is exactly this key.
//
// So a favorite joins cleanly against catalog data without a second
// normalization step anywhere, and a row read back out of this table can be
// dropped straight into a store-page href.
//
// Normalization happens HERE, at the write boundary, not at the call site: a
// row in this table is always already normalized, and an input that names no
// real store (a bare public suffix like `co.uk`, an invented TLD, junk) is
// refused rather than stored — the same refusal `/coupons/[store]` makes, for
// the same reason (see storeDomain.ts's header: treating `co.uk` as a store
// once returned another brand's coupons for 230 hostnames).
import prisma from '@/lib/prisma'
import { resolveStoreDomain } from '@/lib/storeDomain'

/** One followed store as the API serves it. */
export interface FavoriteStoreRecord {
    /** The normalized store key — see this module's header. */
    store: string
    /** ISO timestamp of when the user starred it. */
    createdAt: string
}

/**
 * The store key for `raw`, or null when `raw` names no real store. Callers
 * MUST reject null (422) rather than passing the raw value through — this is
 * the only sanctioned way to turn user input into a `store_name`.
 */
export function normalizeFavoriteStoreKey(raw: string): string | null {
    return resolveStoreDomain(raw)
}

/** Every store `userId` follows, most recently starred first. */
export async function listFavoriteStores(
    userId: string,
): Promise<FavoriteStoreRecord[]> {
    const rows = await prisma.favoriteStore.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { storeName: true, createdAt: true },
    })
    return rows.map(row => ({
        store: row.storeName,
        createdAt: row.createdAt.toISOString(),
    }))
}

/**
 * Follows `storeName` for `userId`. IDEMPOTENT: starring an already-starred
 * store is a success, not a conflict — the star is a toggle the extension and
 * the web page can both fire, and a double-tap must not produce an error the
 * user has to think about.
 *
 * `update: {}` is load-bearing, not a placeholder: re-starring must NOT reset
 * `createdAt` (the profile page orders by it) and must NOT touch
 * `notifyOnNew`, which is a dormant column this PR never writes.
 */
export async function addFavoriteStore(
    userId: string,
    storeName: string,
): Promise<void> {
    await prisma.favoriteStore.upsert({
        where: { userId_storeName: { userId, storeName } },
        create: { userId, storeName },
        update: {},
    })
}

/**
 * Unfollows `storeName` for `userId`. IDEMPOTENT the other way: `deleteMany`
 * rather than `delete` because a `delete` on a missing composite key throws
 * P2025, which would turn an unstar of something already unstarred (a stale
 * popup, a double-tap, an undo that raced) into a 500. Zero rows removed is a
 * correct outcome here, not an error.
 */
export async function removeFavoriteStore(
    userId: string,
    storeName: string,
): Promise<void> {
    await prisma.favoriteStore.deleteMany({ where: { userId, storeName } })
}
