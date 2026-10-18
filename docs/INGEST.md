# Coupons Catalog Ingest

The app **owns** its coupon catalog (`coupons` / `store_configs` / `sources`,
in the app's own Postgres — `DATABASE_URL`). The external Python verification
service is a **supplier**: it pushes catalog changes into the app rather than
the app reading the supplier's database. This is the authoritative contract for
that push.

One endpoint, one engine. Both the trusted-supplier push
(`POST /api/ingest/catalog`) and the migration-period `bridge:sync` job apply
their rows through the SAME pure function, `applyCatalogRows()`
(`src/lib/catalog/applyCatalogRows.ts`) — a 1-row push and a 23k-row push take
the identical path.

> Every JSON value in this doc is a **synthetic illustration**, never real
> scraped catalog data or a real selector.

## The endpoint

`POST /api/ingest/catalog` — the ONE idempotent write door for supplier data.

- **Auth:** a server-only bearer, `INGEST_API_KEY`
  (`Authorization: Bearer <key>`). The check is constant-time and fail-closed —
  an unset key rejects every request. This key is server-to-server only and is
  never shipped to any client; it is distinct from `COUPONS_ADMIN_SECRET`.
- **No CORS, no `OPTIONS`, no rate-limit:** this is server-to-server (no browser
  origin, no preflight), the bearer is the access control, and the trusted
  supplier is deliberately un-throttled so it can push changes as they happen.
- **Body:** validated by `IngestCatalogPayloadSchema`
  (`src/lib/catalog/ingestSchemas.ts`).
- **Errors** thrown out of `applyCatalogRows` (bad data mid-batch, DB loss, …)
  propagate to `handleRouteError` → Sentry — never swallowed.

### Responses

| Status | Body                              | Meaning                                                                          |
| ------ | --------------------------------- | -------------------------------------------------------------------------------- |
| `200`  | `{ ok: true, applied: <result> }` | Applied. `applied` is the counts object (below).                                 |
| `409`  | `{ error, gate }`                 | The tombstone safety gate refused the push — **nothing was written**. See below. |
| `422`  | zod error                         | Invalid body, including a fully-empty payload (no rows in any array).            |
| `401`  | `{ error: 'Unauthorized' }`       | Missing/wrong bearer.                                                            |

## Payload

```json
{
    "coupons": [],
    "storeConfigs": [],
    "sources": [],
    "force": false
}
```

- Each of `coupons` / `storeConfigs` / `sources` **defaults to `[]`**, so a
  producer can send only the entity it changed (coupons-only, sources-only, …).
- A payload with **zero rows across all three arrays is rejected `422`** — an
  empty push is almost always a producer bug, and surfacing it loudly is the
  point.
- `force` (default `false`) bypasses the tombstone safety gate (see
  [Apply semantics](#apply-semantics-applycatalogrows)).
- **Wire keys are `snake_case`** and map **1:1** to the SQL column names, so
  there is no silent rename layer between producer and `INSERT`.
- **`updated_at` is the ordering key.** It is **required on every coupon** — a
  coupon row without it cannot be ordered against the stored row and is rejected
  at parse time (never defaulted). On `storeConfigs`/`sources` it is optional;
  when omitted, apply-time coalesces it to `now()` (last-write-wins).

### `coupons[]` — the `coupons` table

| Field                  | Type / rule                                 | Notes                                                                         |
| ---------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| `id`                   | string or number → string, **`^\d{1,18}$`** | The pipeline coupon id; a garbage id is rejected at the write boundary.       |
| `code`                 | string (required)                           |                                                                               |
| `site`                 | string \| **null**                          | Column is nullable; a read query may still guarantee it non-null.             |
| `title`                | string (required)                           |                                                                               |
| `description`          | string (required)                           |                                                                               |
| `rating`               | coerced number, default `0`                 |                                                                               |
| `discount_type`        | string \| null                              | **OPEN string, stored raw** — never normalized/enum'd on write.               |
| `discount_amount`      | coerced number \| null                      |                                                                               |
| `expiry`               | string \| null                              | A `TEXT` column (free-form), never a real `DateTime`.                         |
| `expired`              | boolean, default `false`                    |                                                                               |
| `times_used`           | int ≥ 0, default `0`                        | The DB enforces the `int4` range (an out-of-range value fails the `INSERT`).  |
| `last_time_used`       | date \| null, optional                      |                                                                               |
| `status`               | string (required)                           | **OPEN string, stored raw** — a coupon always has a lifecycle status.         |
| `verification_message` | string \| null                              |                                                                               |
| `created_at`           | date, optional                              | Set on `INSERT` only; defaults to `now()` when omitted, preserved thereafter. |
| `updated_at`           | date, **required**                          | The only-if-newer ordering key.                                               |

### `storeConfigs[]` — the `store_configs` table (PK `store_name`)

`store_name` (required, non-empty) plus the 8 apply-config xpath fields, **all
nullable and optional** (the table columns are nullable, and a producer may push
a partial config): `show_input_xpath`, `dismiss_button_xpath`,
`coupon_input_xpath`, `apply_button_xpath`, `price_container_xpath`,
`success_indicator_xpath`, `error_indicator_xpath`, `coupon_remove_xpath`. Plus
optional `updated_at` / `created_at`.

This is the FLATTENED published shape (one row per store). The scraper's
internal `verification_stores ⋈ store_verification_configs` join that PRODUCES
it stays pipeline-internal and is never modelled here (secrecy forward-rule —
see DESIGN.md §2(k)).

### `sources[]` — the `sources` table (PK `id`)

`id` (required, non-empty text — a UUID/text, NOT the numeric coupon-id shape),
`source` (string), `websites` (string array, default `[]`), `status` (string),
plus optional `updated_at` / `created_at`. The read-time per-source aggregates
(`total_coupons`, …) are computed by a JOIN and are never stored, so they are
absent here.

### Synthetic example

```json
{
    "coupons": [
        {
            "id": "1001",
            "code": "SAVE10",
            "site": "example.com",
            "title": "10% off sitewide (synthetic example)",
            "description": "Illustrative only — not real catalog data",
            "rating": 0,
            "discount_type": "PERCENTAGE",
            "discount_amount": 10,
            "expiry": null,
            "expired": false,
            "times_used": 0,
            "last_time_used": null,
            "status": "valid",
            "verification_message": null,
            "updated_at": "2026-07-14T12:00:00Z"
        }
    ],
    "storeConfigs": [
        {
            "store_name": "example.com",
            "coupon_input_xpath": "«synthetic-placeholder»",
            "apply_button_xpath": "«synthetic-placeholder»",
            "updated_at": "2026-07-14T12:00:00Z"
        }
    ],
    "sources": [],
    "force": false
}
```

## Apply semantics (`applyCatalogRows`)

A **pure DELTA UPSERT**, never a snapshot/replace:

- **Only-if-newer.** Each row carries its own `updated_at`; a row is applied ONLY
  when it is at least as new as the stored row. Retries and out-of-order delivery
  are therefore idempotent and safe — replaying an old push, or receiving pushes
  out of sequence, never regresses the catalog. (The authoritative guard is the
  `ON CONFLICT … WHERE excluded.updated_at >= <table>.updated_at` clause.)
- **Tombstoning is per-row, never by absence.** A coupon going expired /
  non-visible tombstones only when a pushed row flips a currently-visible coupon
  to expired/non-visible. A coupon simply missing from a push is never deleted or
  expired for being absent — there is no batch-end reconciliation.
- **One transaction.** The whole apply runs in a single interactive
  `prisma.$transaction`; a failure part-way through a multi-row push rolls
  everything back, so the catalog is never left half-written.
- **Dedupe + chunking.** Duplicate keys within one push are collapsed keeping the
  newest `updated_at`; writes are chunked to stay under Postgres' parameter cap.

### Tombstone safety gate

A single push that would tombstone/expire **more than 20% of the
currently-visible catalog is REFUSED** (`409`, `gated: true`) unless
`force: true`. A gated push **writes nothing** (the transaction rolls back). The
`409` body carries the detail:

```json
{
    "error": "Ingest refused: this push would expire N of M visible coupons (>20% of the catalog). Resend with force:true if this is intentional.",
    "gate": { "wouldTombstone": 0, "visibleBefore": 0, "thresholdPct": 20 }
}
```

This guards against a broken producer wiping the catalog with one bad push. A
genuinely large expiry is still possible by **re-sending with `"force": true`**
once a human has confirmed it is legitimate.

### Result counts

A non-gated `200` returns:

```json
{
    "gated": false,
    "coupons": {
        "inserted": 0,
        "updated": 0,
        "skippedOlder": 0,
        "tombstoned": 0,
        "skippedReferral": 0,
        "skippedIdMismatch": 0
    },
    "storeConfigs": { "upserted": 0 },
    "sources": { "upserted": 0 }
}
```

`skippedOlder` counts rows dropped by the only-if-newer rule; `tombstoned`
counts applied rows that flipped a visible coupon to non-visible;
`skippedReferral` counts personal referral codes (`isReferralCoupon` in
`src/lib/coupons.ts`: "refer a friend", "code in the link", ...) that were not
in the catalog yet and so were not inserted. A referral row that IS already
stored is written with `expired = true` (the one value the engine forces, so it
leaves via the normal tombstone path and counts toward the 20% gate).
`skippedIdMismatch` counts rows whose id is already stored with a DIFFERENT
coupon: another site, or another code (letter case ignored). Those rows are
never written, so they neither update, expire nor tombstone the stored coupon;
their ids (never codes) are logged as `[ingest/catalog] skippedIdMismatch=...`.
The app's ids come from two id spaces (the 2026-08-08 bridge-sync seed from the
dev coupons DB, and the prod pipeline DB that re-minted ids from 74351 on
2026-08-10/11), so the id alone does not prove the row is the same coupon. Every
applied push also logs one `[ingest/catalog] coupons inserted=... skippedIdMismatch=...`
summary line. For
`storeConfigs`/`sources`, `upserted` is the number of rows offered after dedupe
(an idempotent re-affirmation of unchanged rows is not a failure).

## Bridge sync (migration-period feed)

Until the Python pipeline is switched to push `POST /api/ingest/catalog`
directly, the catalog is kept fresh by the **bridge sync** job
(`scripts/bridge-sync.ts`):

```bash
COUPONS_DATABASE_URL=<read-only-external-url> pnpm --filter caramel-app bridge:sync
```

- It reads the still-live external, Python-owned `caramel_coupons` Postgres
  **strictly read-only (SELECTs only, never a write)** and replays that catalog
  through the SAME `applyCatalogRows()` engine — the same only-if-newer delta
  upsert and the same >20% tombstone gate.
- `COUPONS_DATABASE_URL` is the read-only external connection string. It is
  **OPTIONAL for the app** (unset in local dev; the app always serves its own
  `DATABASE_URL` catalog) and **REQUIRED only for this job**.
- It logs `OK` with per-entity counts, or `REFUSED` (tombstone gate) / `FAILED`
  and exits non-zero — never a silent no-op.

The bridge is **temporary**: it retires once the pipeline pushes to the ingest
endpoint directly (a later workstream).

## Deferred human tasks

- **Bridge `--force` flag.** After a gated mass-tombstone is confirmed
  legitimate, an operator re-run needs `force`. The engine and payload already
  support it (`runBridge(sql, { force: true })` / `"force": true` on the push);
  a `--force` CLI flag for `scripts/bridge-sync.ts` is a `TODO:` in that file,
  to be wired by a human the first time it's actually needed.
- **"used today" count → `workCount`.** The web coupon card
  (`src/components/coupons/coupon-card.tsx`) still shows "N used today" sourced
  from the catalog's `coupon.timesUsed`. Post-signal-split, usage telemetry
  lives in the app-owned `coupon_signals.workCount`
  (`couponSignals.recordUsage`), which was deliberately split out of the catalog
  so a usage bump never touches `coupons.updated_at` (that would freeze the row
  under the only-if-newer ingest rule). Switching the display to `workCount` is
  **deferred pending UX sign-off** and carries a `TODO:` marker at the display
  site.
