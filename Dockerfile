# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────────
# caramel-app production image — one-root-compose (F-016).
# Context = repo root. Multi-stage turbo-prune build. Local, CI and prod all
# build + run this exact file (as one platform compose service), so behaviour
# is identical everywhere. next.config.mjs emits `output: 'standalone'`.
# ──────────────────────────────────────────────────────────────────────────

# ---- base: pinned node + the EXACT pnpm from package.json packageManager ----
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Heavy/optional postinstalls that the app build does not need (and which would
# fail or bloat the image in a network-restricted layer).
ENV HUSKY=0
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# ---- pruner: reduce the monorepo to the caramel-app subgraph ----
FROM base AS pruner
WORKDIR /app
COPY . .
# Pinned turbo (never floating) — deterministic prune.
RUN pnpm dlx turbo@2.5.4 prune caramel-app --docker

# ---- builder: install pruned deps, generate the Prisma client, build ----
FROM base AS builder
WORKDIR /app
# Lockfile + package.json layer first so `pnpm install` caches across source edits.
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
# Full pruned source.
COPY --from=pruner /app/out/full/ ./

# Build-time NEXT_PUBLIC_* — every var env.client.ts reads. Defaults are
# LOCAL-SAFE or EMPTY only; NEVER a production identifier (public repo). Deploy
# platforms pass real values via --build-arg. env.client.ts never throws on a
# missing/empty public var, so empty defaults are safe.
ARG NEXT_PUBLIC_BASE_URL=http://localhost:58000
ARG NEXT_PUBLIC_SENTRY_DSN=
ARG NEXT_PUBLIC_GOOGLE_ANALYTICS_ID=
ARG NEXT_PUBLIC_API_ENCRYPTION_ENABLED=
# PostHog (feedback+observability). DATASET defaults to 'disabled' (safe: no
# capture) so an image built without platform args never phones home. The
# capture pairs are empty by default; deploy platforms pass real values via
# --build-arg. NEXT_PUBLIC_APP_VERSION is NOT here — next.config.mjs injects it
# from package.json, so it needs no build arg.
ARG NEXT_PUBLIC_POSTHOG_DATASET=disabled
ARG NEXT_PUBLIC_POSTHOG_HOST=
ARG NEXT_PUBLIC_POSTHOG_KEY=
ARG NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_HOST=
ARG NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_CAPTURE_TOKEN=
ENV NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_GOOGLE_ANALYTICS_ID=$NEXT_PUBLIC_GOOGLE_ANALYTICS_ID
ENV NEXT_PUBLIC_API_ENCRYPTION_ENABLED=$NEXT_PUBLIC_API_ENCRYPTION_ENABLED
ENV NEXT_PUBLIC_POSTHOG_DATASET=$NEXT_PUBLIC_POSTHOG_DATASET
ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY
ENV NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_HOST=$NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_HOST
ENV NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_CAPTURE_TOKEN=$NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_CAPTURE_TOKEN
# Prod build: next.config.mjs only wraps Sentry when NODE_ENV=production.
ENV NODE_ENV=production
# Build-time-only placeholders: next build's page-data collection imports
# route modules, and env.ts eagerly zod-parses at import. These THREE keys are
# the schema's required set; the values are never read by the running
# container (the runner stage inherits no builder env — runtime env comes from
# compose environment/env_file, and instrumentation.ts re-validates the REAL
# env at boot, so fail-fast is intact). The .invalid TLD is reserved and
# unresolvable, so any accidental build-time DB connection fails loudly
# instead of silently reaching a real database.
ENV DATABASE_URL=postgresql://build-placeholder:build-placeholder@db.build-placeholder.invalid:5432/build_placeholder
ENV COUPONS_DATABASE_URL=postgresql://build-placeholder:build-placeholder@db.build-placeholder.invalid:5432/build_placeholder
ENV BETTER_AUTH_SECRET=build-placeholder-not-a-secret
# caramel-app's `build` script is `npx prisma generate && next build`, so the
# Prisma client is generated here explicitly (musl engine, same platform as the
# runner) before the standalone trace.
# pnpm-direct, NOT `turbo run build`: turbo 2's strict env mode passes child
# tasks only turbo.json-declared vars (this repo declares none) plus
# framework-inferred NEXT_PUBLIC_*, which strips the build-time placeholders
# above — and the platform build args — before `next build` sees them.
# Declaring them in turbo.json would duplicate env.ts's vocabulary into a
# second drift-prone file. Turbo still earns its keep in the prune stage; in
# this pruned single-app image the build is one task with no cache anyway
# (caramel-app has no workspace deps, so `dependsOn: ^build` is empty in
# practice).
RUN pnpm --filter caramel-app run build

# Self-contained Prisma CLI for the runner's boot-time `migrate deploy`.
# npm (not pnpm) gives a flat node_modules with every transitive dep real —
# pnpm's isolated symlinks don't survive a cross-stage COPY (its deps live as
# siblings in the virtual store, e.g. @prisma/engines, and cp -RL loses them).
# The version comes from the app's own package.json (`dependencies.prisma`,
# exact-pinned per repo rule) — one pin, no drift.
RUN PRISMA_VERSION=$(node -p "require('./apps/caramel-app/package.json').dependencies.prisma") \
  && npm install --prefix /prisma-cli "prisma@${PRISMA_VERSION}" --no-save --no-audit --no-fund

# ---- runner: minimal standalone server; migrate then serve ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone server bundle (real, traced node_modules incl. @prisma/client +
# query engine). outputFileTracingRoot = monorepo root, so the app lands under
# apps/caramel-app/ inside the standalone tree.
COPY --from=builder --chown=nextjs:nodejs /app/apps/caramel-app/.next/standalone ./
# Static assets + public are not part of the standalone bundle.
COPY --from=builder --chown=nextjs:nodejs /app/apps/caramel-app/.next/static ./apps/caramel-app/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/caramel-app/public ./apps/caramel-app/public
# Prisma schema + migrations for `migrate deploy`.
COPY --from=builder --chown=nextjs:nodejs /app/apps/caramel-app/prisma ./apps/caramel-app/prisma
# Prisma CLI + engines in their OWN staged tree — the standalone bundle's
# traced node_modules stays pristine (@prisma/client for the running app comes
# from the trace, not from here).
COPY --from=builder --chown=nextjs:nodejs /prisma-cli/node_modules ./prisma-cli/node_modules
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER nextjs
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
