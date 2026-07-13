# Cart-classifier evals (F-012)

Eval suite for the repo's only user-facing LLM surface:
`cartClassifier.ts` → `openrouter.ts` → `POST /api/classify-cart`. It
classifies a cart into one of 16 categories so the popup can show a
restriction-relevant hint ("your cart looks like electronics") on
restricted coupons — advisory only, never a hard filter.

See `audit/plans/PLAN-F-012.md` for the full plan and
`~/.claude/skills/codebase-audit/references/shared-claude-rules.md`
§"AI quality (evals)" for the rule this exists to satisfy.

## Current status (read this first)

**Live baseline: GREEN** — 97.5% primary-match (39/40), schema-valid
100%, p95 latency 5965ms, green ×2 on the shipped configuration.

The suite's very first run (F-012) came back RED at 5.0% — it caught a
real, previously-invisible production bug on day one: `classifyCart()`'s
`maxTokens: 120` starved `openai/gpt-5-mini`'s hidden reasoning tokens,
so ~95% of live calls returned an empty response. That finding was
promoted to **F-017** and fixed by empirically resizing the budget to
`maxTokens: 600`, using this suite as the measurement harness. Both the
red baseline row and the candidate-sizing table live in `SCOREBOARD.md`
as the permanent before/after record.

## What's here

- `fixtures/cart-cases.ts` — 40 labeled `CartSignals` cases in the real
  wire shape (`apps/caramel-extension/cart-signals.js`'s
  `collectCartSignals()` payload): 16 clear per-category exemplars, 10
  realistic multi-item carts, 8 ambiguous/adversarial cases (including two
  prompt-injection attempts the model must resist), 6 junk/non-commerce
  pages.
- `scorers.ts` — pure, deterministic scorers (no LLM-as-judge): primary
  category match, secondary-tolerant match, confidence bounds, schema
  validity, latency budget. A case passes only if every scorer passes.
  Also the shared `runEvalSuite()` harness both the live suite and the
  free mocked-pipeline unit test call — see below.
- `cartClassifier.eval.ts` — the LIVE suite. Imports the real
  `classifyCart` (real prompt, real parsing/schema — never copied) and
  calls it against every fixture case, then gates on the primary-match
  rate.
- `SCOREBOARD.md` — dated rows from real baseline runs.

`cartClassifier.eval.ts` is **not** part of the regular unit suite —
F-004's `vitest.config.ts` excludes `**/*.eval.*`; only
`vitest.eval.config.ts` (`include: ['evals/**/*.eval.ts']`) collects it.
Free, non-live coverage of the same scoring/aggregation logic lives in
`tests/unit/cartClassifier.scorers.test.ts` and
`tests/unit/cartClassifier.pipeline.test.ts` (mocked `chat()`, zero API
calls, runs on every normal `pnpm test`).

## Why 0.85

Primary-match rate ≥ 0.85 over the 40-case dataset. The dataset isn't
uniformly easy: 8 of the 40 cases (20%) are deliberately ambiguous or
adversarial, where even a well-behaved model may reasonably land on either
of two accepted categories, or where resisting a prompt-injection attempt
is the actual thing under test. 0.85 leaves room for that designed-in
difficulty while still catching a real regression or provider drift — a
model that stops resisting the injection cases, or starts missing the 16
unambiguous exemplars, drops well below threshold.

## Running it

```bash
cd apps/caramel-app
pnpm eval
```

Reads `OPENROUTER_API_KEY` (and `OPENROUTER_MODEL`, if you want to
override the code default) from this package's own `.env` —
`vitest.eval.config.ts` loads it via Node's built-in
`process.loadEnvFile()` (no dotenv-cli, no new dependency; see
`PLAN-F-012.md`'s CR-9). Costs real OpenRouter spend: ~40 short
completions at `temperature: 0`, well under $0.20 per full run.

## Red-proof

Proves the gate actually bites, two ways:

1. **Free, permanent, every `pnpm test` run** —
   `tests/unit/cartClassifier.pipeline.test.ts`'s "scrambled-label
   variant" test: mocked `chat()`, rotates the expected label of 4 canned
   cases by one position, and asserts `runEvalSuite()` reports
   `primaryMatchRate < 0.85` with every case named as failing. Zero API
   cost, runs in CI's regular "unit" task on every PR.
2. **Live, cheap, on-demand** — `SCRAMBLE_EVAL=1` re-runs the real
   `cartClassifier.eval.ts` against only the first 8 fixture cases (one
   per category, by construction — see the module comment in
   `fixtures/cart-cases.ts`) with each case's expected label rotated onto
   its neighbor, so a correctly-functioning model still fails nearly every
   one. This is the cheapest live variant that still exercises the real
   CI command end-to-end (~8 calls, a fraction of the full baseline's
   cost) rather than re-spending the full ~$0.20 baseline a second time.

    ```bash
    cd apps/caramel-app
    SCRAMBLE_EVAL=1 pnpm eval
    ```

    Expect a non-zero exit and the gate `it`'s failure message naming every
    failing case, e.g.:

    `primary_match_rate=0.0% (8 cases) — failing: apparel-exemplar, beauty-exemplar, books_media-exemplar, electronics-exemplar, food_grocery-exemplar, health_supplements-exemplar, home_garden-exemplar, jewelry_accessories-exemplar`

    (See `SCOREBOARD.md` for the actual recorded run.)

## CI (`.github/workflows/ai-evals.yml`)

- **Pull request** — path-filtered to the AI surface
  (`cartClassifier.ts`, `openrouter.ts`, `env.ts`, `classify-cart/**`,
  `evals/**`, `vitest.eval.config.ts`, `package.json`, the workflow
  itself) so unrelated PRs never pay for, or see a stochastic red from, a
  live call.
- **Nightly** (`schedule`, 09:00 UTC) — the only thing that catches a
  provider silently degrading/swapping the model with zero code change.
  Opens a GitHub issue on failure (only fires on the default branch —
  GitHub only evaluates `schedule` triggers there).
- **`workflow_dispatch`** — manual re-run.
- First real step: fails loudly (`::error::`) if the `OPENROUTER_API_KEY`
  repo secret is unset — no silent skip.

### Secret handoff (human, post-merge)

The repo has **no `OPENROUTER_API_KEY` secret** (`gh secret list`,
re-checked at execution time) — the PR/nightly eval leg is **red by
design** until a human adds it: GitHub → repo Settings → Secrets and
variables → Actions → `OPENROUTER_API_KEY`. Then promote this workflow to
`main` so the nightly cron actually arms.

### Deploy-time model pin (Dokploy)

Checked directly against the production Dokploy app (`NextJS (Dokploy)`,
`grabcaramel.com`/`www.grabcaramel.com`, `main` branch,
`buildPath: /apps/caramel-app`) on 2026-07-11:

**Neither `OPENROUTER_API_KEY` nor `OPENROUTER_MODEL` is set in
production.** `src/lib/env.ts` makes `OPENROUTER_MODEL` optional (default
`openai/gpt-5-mini`) but `OPENROUTER_API_KEY` has no default — so
`chat()` currently throws `"OPENROUTER_API_KEY not set"` on every real
`/api/classify-cart` call in production today. This is a pre-existing
operational gap (not introduced by, or in scope for, F-012 — this finding
adds the detection gate; provisioning prod secrets is infra work) —
surfaced here, and separately, as a new-finding candidate in the F-012
Stage-3 report. Whoever adds the CI secret above should add the matching
Dokploy env var at the same time, and update this note with whatever
model id ends up pinned.

## Codify

> AI model/prompt changes are eval-gated: `pnpm eval` green **twice**
> plus a dated `SCOREBOARD.md` row in the same commit before a model or
> prompt swap ships. Real production misclassifications become new eval
> cases (in `fixtures/cart-cases.ts`) before or with the fix that
> addresses them.

The canonical copy of this rule lives in the repo root `CLAUDE.md`
(§Conventions in force → eval gate); this section stays as the local
how-to. If the two ever disagree, `CLAUDE.md` wins.
