# PLAN-F-017 — cartClassifier maxTokens starves the reasoning model (eval-caught, fix in-train)

**Finding:** F-017 (NEW, High, ai-quality/correctness — discovered by F-012's eval baseline) · **Effort:** S · **Sequence:** 14.5 (immediately after F-012, before F-010 so docs describe the fixed reality) · **Depends-on:** F-012 (the eval suite IS the verification harness).

**Finding statement (schema-compatible, for findings.json):** `classifyCart()` calls `chat()` with `maxTokens: 120` while the default model `openai/gpt-5-mini` is a reasoning model whose hidden reasoning tokens consume the entire completion budget on most carts → `finish_reason:"length"`, `content:null` → `OpenRouterError("empty response")` on ~95% of live calls (eval baseline: 5% primary-match, 2/40). Diagnostic evidence in `evals/SCOREBOARD.md`: same cart at `max_tokens:600` → `finish_reason:"stop"` + correct JSON. Before F-002, this failure was swallowed as fake-empty; the surface has likely been near-dead in prod since the gpt-5-mini default landed (prod ALSO lacks the API key — separate ops finding).

## Scope

- `apps/caramel-app/src/lib/cartClassifier.ts` — the `chat()` call's token budget (and ONLY that call's parameters).
- `evals/SCOREBOARD.md` — new dated row from the post-fix green baseline run.
- OUT of scope: model swap (needs its own eval-gated cycle), prompt changes, cache changes, route changes, provisioning prod env (ops).

## Approach

1. Empirically size the budget with the EXISTING eval suite as the harness: candidate values 400 / 600 / 800 (reasoning models need headroom; OpenRouter passes max_tokens through). For each candidate that reaches a green gate (≥0.85 primary-match), record pass-rate, p50/p95 latency (budget: must fit the existing 7000ms timeoutMs with margin — if p95 busts it, prefer a larger token budget only if latency allows, else consider OpenRouter's `reasoning: {effort:'low'}` parameter as the measured alternative — verify current OpenRouter API docs before using), and $/call.
2. Ship the cheapest candidate that is BOTH gate-green and latency-safe. One-line-class diff plus a `// F-017:` comment stating the reasoning-model constraint.
3. Re-run `pnpm eval` ONCE more on the chosen value for the official scoreboard row (green baseline ×2 total on the shipped value — satisfies the v5 "green twice" spirit for the parameter change).
4. Unit pins: cartClassifier.parse pins are transport-mocked and unaffected; no pin flips expected. tsc/lint/knip/prettier green.

## Breaking changes

None wire-facing (`{primary,secondary,confidence,cached}` unchanged). Cost per call rises (reasoning tokens billed) — record the measured $/call delta in the scoreboard row; at observed volumes this is cents-level.

## Rollback

Single commit `fix(F-017): size cartClassifier token budget for reasoning models (eval-gated)`; revert restores the (broken) 120 — eval gate would go red again, which is correct.

## Risk

Worst case: chosen budget still truncates edge carts (long titles) → those cases fail the gate → visible immediately in the run, iterate before shipping. Latency regression guarded by the latency scorer. Budget: ≤3 candidate runs + 1 confirmation ≈ ≤160 live calls, still cents.

**Lead self-approval (gate-collapse mode):** approved as an in-train micro-fix rather than next-cycle debt because (a) the defect makes a shipped user-facing feature ~95% dead, (b) the brand-new eval gate stays permanently red otherwise — a red-at-birth gate invites deletion and defeats F-012's purpose, (c) the verification harness (the eval suite) already exists, making this the cheapest-possible-risk fix. Logged in state.json.
