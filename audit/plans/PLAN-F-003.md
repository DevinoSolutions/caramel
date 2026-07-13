# PLAN-F-003 — Split the shipped public key from privileged server auth + rate-limit exemption

**Finding:** F-003 (Critical) · A static key shipped in the public extension gates a destructive mutation (`coupons/expire`) and exempts its holder from rate limiting.
**Effort:** S · **Wave:** 2 · **Sequence:** 4 of 15 · **Depends-on:** F-004 (vitest + `rateLimit.test.ts` pins — pos 1), F-005 (`src/lib/env.ts` + regenerated `.env.example` — pos 2), F-009 (fossils gone — pos 3).

## Executive summary

Retire the public `EXTENSION_API_KEY` from all three privileged roles. `coupons/expire` → server-only `COUPONS_ADMIN_SECRET` bearer (mirrors `health.authorize`), fail-closed. Rate-limit exemption keys off that same server secret, not the shipped string. `supported-stores` (the only live extension key-call) → keyless **public read** behind `checkRateLimit(req,'read')`, so old in-the-wild clients that still send the dead key degrade gracefully (header ignored → 200). Extension stops shipping/sending the key. ~9 files (5 src, 2 extension, 2 test-add + 1 test-edit). **Breaking: Y** (server-only; no in-wild client calls expire; see §Breaking). **Riskiest step:** the atomic server auth swap — `env.EXTENSION_API_KEY` reads must all flip in one checkpoint or `tsc` breaks.

## Scope

**Modify (server):** `src/app/api/coupons/expire/route.ts` (auth block 15-19); `src/lib/rateLimit.ts` (`isExtensionClient`→`isTrustedServer`, 56-63,91); `src/app/api/extension/supported-stores/route.ts` (drop key gate, add read-limit); `src/lib/env.ts` (F-005 module: drop `EXTENSION_API_KEY`, add `COUPONS_ADMIN_SECRET`); `apps/caramel-app/.env.example` (F-005-regenerated: swap the two vars).
**Modify (extension, ships w/ release):** `background.js` (delete const :23, drop `x-api-key` header :208); `scripts/test-extension.mjs` (delete const :32, drop header :114/:151/:122).
**Create (tests):** `src/app/api/coupons/expire/route.test.ts`; `src/app/api/extension/supported-stores/route.test.ts`. **Edit test:** `src/lib/rateLimit.test.ts` (flip F-004 pins).
**OUT of scope:** any auth re-architecture; the naive-vs-constant-time compare unification across sites (DD3-2 → F-007's `apiKey.ts` hook); an extension "report expired coupon" feature (keyless advisory endpoint) — **park as next-cycle finding** if product wants it; `ci-env.ts` (no CI path calls expire; supported-stores is public in e2e).

## Approach

- **expire = ops/server-only.** Verified **nothing in-repo (or the extension) calls `/api/coupons/expire`** — it is effectively an ops endpoint. Gate it with `Authorization: Bearer $COUPONS_ADMIN_SECRET`, fail-closed when unset (exact shape of `health.ts:authorize`, the repo's one server-secret convention). Rejected: keep `x-api-key` (re-conflates with the retired public header); downgrade to keyless zod advisory signal (no caller exists → pure abuse surface; that's a _new feature_, not this fix).
- **Exemption keys off server identity.** `isTrustedServer(req)` checks the same bearer secret; the public key grants nothing. Matches finding fix_direction verbatim. Rejected: delete the exemption outright — loses operability for the legit high-volume ops caller.
- **supported-stores = public read.** It is the only live extension key-call and returns data already shipped to every install (in-page xpath selectors) — no secrecy value. Making it public + `checkRateLimit(req,'read')` (mirrors `coupons/route.ts:20`) means old clients sending the stale `x-api-key` get their header **ignored → 200** (graceful), while the key confers zero privilege the instant we deploy. Rejected: rotate the key (breaks every in-wild install during store-review lag — the mandatory caveat).
- **New secret name `COUPONS_ADMIN_SECRET`** (covers server-to-server coupon mutation + its rate-limit trust), **server-optional** in F-005's schema (fail-closed in code, so CI/dev boot without it — consistent with F-005's minimal required-set).

## Sequencing (each step ends with its check)

1. **Pins first — current behavior.** Add `expire/route.test.ts` + `supported-stores/route.test.ts` characterizing TODAY: `vi.mock('@/lib/couponsDb')`, `env.EXTENSION_API_KEY` set, `x-api-key` header. **Check:** `pnpm --filter caramel-landing test` green (`rateLimit.test.ts` current pins already green from F-004).
2. **Atomic server auth swap.** `env.ts`: remove `EXTENSION_API_KEY`, add `COUPONS_ADMIN_SECRET: z.string().optional()`. `expire/route.ts`: replace 15-19 with bearer-vs-`env.COUPONS_ADMIN_SECRET`, fail-closed 401. `rateLimit.ts`: `isTrustedServer` reads `Authorization: Bearer`→`env.COUPONS_ADMIN_SECRET` (drop `x-api-key`/`x-extension-api-key`); line 91 uses it. `supported-stores/route.ts`: delete `validateApiKey`/`EXTENSION_API_KEY`/`unauthorized`/gate; prepend `const limited = await checkRateLimit(req,'read'); if(limited) return limited`. Regenerate `.env.example` var. **Check:** `tsc --noEmit` green; grep `EXTENSION_API_KEY` in `src/` + `.env.example` = 0 hits; `next dev` boots.
3. **Flip/extend tests.** `rateLimit.test.ts`: pins (a)+(b) [old key across 25 calls / `x-extension-api-key`] → now **NOT** exempt (rides burst → 429); ADD (d) `Authorization: Bearer $secret` → `null` (exempt); keep (c). `expire/route.test.ts`: auth→bearer (no/wrong/**unset**→401; valid→handler); ids-branches (empty→`{count:0}`, >50→400, dedupe+`/^\d{1,18}$/`→cleaned array reaches `couponsSql`, `{count}`) **unchanged**. `supported-stores/route.test.ts`: no key→200; **stale `x-api-key`→200** (graceful); rate-limit delegated (mock→429 passes through). **Check:** full suite green.
4. **Extension cleanup.** Delete key const + drop `x-api-key` header in `background.js` (:208 → bare `fetchWithTimeout(url)`) and `test-extension.mjs`. **Check:** `pnpm --filter caramel-extension test` green (supported-stores now public); manual `curl` of expire w/o bearer → 401, with bearer → 200.
5. **Commit** `fix(F-003): server-only expire secret + identity-based rate-limit exemption; keyless public supported-stores`.

## Breaking changes

- **`coupons/expire` auth changes** (`x-api-key`→server bearer). **No in-repo/in-wild client calls it** (verified) → zero client breakage. Any _out-of-repo_ ops/scraper that calls it must send `Authorization: Bearer $COUPONS_ADMIN_SECRET`; until `COUPONS_ADMIN_SECRET` is set it fail-closes 401 (safe, not a 500).
- **Old extensions lose the rate-limit exemption** on `supported-stores` → ride read limits (120/min/IP, 20/2s burst). Non-crippling: endpoint is `storage.local`-TTL-cached client-side + CDN `s-maxage=300`, hit only on cache-miss. **No tier change needed.**
- **`supported-stores` becomes public** → old clients' stale key header is ignored (200), new clients send nothing (200). **No hard cutover / no store-lag breakage** — server tolerates both indefinitely; extension edit is cosmetic cleanup shipping with the next release.
- **Old key retired server-side immediately** on deploy (nothing reads `EXTENSION_API_KEY`) — satisfies "old key stops conferring ANY privilege at once, old clients still work."
- **Human/ops handoff (post-merge, NOT the executor):** (1) set high-entropy `COUPONS_ADMIN_SECRET` in Dokploy prod+dev before/with deploy; (2) point any external expire caller at the new bearer; (3) delete `EXTENSION_API_KEY` from Dokploy env (immediate, unused); (4) ship extension release (not time-critical). No retirement deadline.

## Test strategy (pins BEFORE change, via F-004 vitest)

F-004 pins the rateLimit **exemption** (flipped in step 3) but does **not** pin expire/supported-stores — F-003 adds both (step 1 = current-behavior characterization; step 3 = post-change). Coupon-id validation is pinned at step 1 and asserted **unchanged** through the auth swap (proves the swap is behavior-isolated). "Green": step 1 all pins pass on current behavior; steps 3-4 full suite green including flipped exemption + fail-closed expire + graceful old-key supported-stores. Mock `@/lib/couponsDb` (recording tag) and `@/lib/env` per-test.

## Rollback

One commit; internal checkpoints at steps 1/2/3/4 (scratch commits) so a failed step restarts without losing pins. `git revert` fully reverses (no data/schema migration). Operational safety-net: if the ops caller isn't cut over, expire returns 401 (not data loss) — set the secret + caller, no code rollback needed. `EXTENSION_API_KEY` re-add is a one-line env restore if any unknown consumer surfaces.

## Risk

**Blast radius:** 1 mutation route + shared rate limiter + 1 read route + the extension's supported-stores fetch. **Worst case:** an unknown external expire caller silently 401s post-deploy (caught early via 401 logs + the ops checklist). **Early warning:** spike in `[ratelimit]` warns on supported-stores (unexpected volume) or 401s on `/coupons/expire`. **Premises verified in code:** expire naive-gate (15-19); `isExtensionClient` private, sole use at :91; supported-stores is the only live extension key-send (`background.js:208`); **no caller of `/api/coupons/expire` anywhere**; public-read pattern = read-limit-only (`coupons/route.ts:20`); bearer server-secret precedent (`health.ts:31-36`); F-005 lands `env.EXTENSION_API_KEY` reads at the 3 sites. **Assumed (verify at exec):** no out-of-repo service depends on the current expire `x-api-key` (not observable from the repo — hence the ops handoff); supported-stores payload carries no field we consider secret (it is client-shipped today).
