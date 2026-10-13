# Gotchas — moved detail (each cost a real debugging round)

Moved verbatim from CLAUDE.md on 2026-10-07 (CLAUDE.md was slimmed to cut context-window cost). Every bullet/paragraph below is unchanged; only the headings and the notes in this style are new.

## Coupon-read test mocks

- Coupon-read tests now mock `@/lib/prisma` (not couponsDb) and assert on the composed `.sql` string: a `Prisma.sql` fragment nested into a `$queryRaw` template INLINES into the parent's flattened `?`-placeholder text, so proving a route uses a shared predicate is a direct string match — read the header in `tests/unit/coupons-visibility.test.ts` / `couponsRepo.test.ts` before touching such mocks.

## Extension env stamp

- Extension env stamp: `CARAMEL_ENV` comes from `import`ing `caramel-env.js` (inlined at build by `wxt.config.ts` from the one table in `scripts/environments.mjs`; `wxt build` = production, a dev stamp needs an explicit `--mode development`). Never decide dev-vs-production at runtime from the manifest (`update_url` is Chrome-Web-Store-only; that heuristic shipped Firefox and Safari builds pointed at dev). The old "cross-file globals / load order = manifest order / `oxlint-disable-next-line no-unused-vars`" gotchas died with the ES-module port: keep new modules free of top-level side effects (`caramel-env.js` writing `globalThis.CARAMEL_ENV` is the deliberate exception) and wire any effect through an `init*` called from `entrypoints/content.ts`.

## In-image Docker build traps

- F-016 in-image build traps (all in `Dockerfile`, with matching comments): the build step MUST stay `pnpm --filter caramel-app run build`, NEVER `turbo run build` — turbo 2's strict env mode passes child tasks only turbo.json-declared vars (this repo declares none) + framework-inferred `NEXT_PUBLIC_*`, so the build-time placeholder env AND the platform `--build-arg`s get stripped before `next build` sees them (masked on the host because Next reads the dockerignored `.env` directly). Two companion patterns are documented in the Dockerfile: the builder-stage `.invalid` placeholder env (DESIGN.md §2(m)), and the Prisma CLI staged via `npm install --prefix /prisma-cli` because pnpm's virtual-store sibling deps don't survive a cross-stage `cp -RL`.
