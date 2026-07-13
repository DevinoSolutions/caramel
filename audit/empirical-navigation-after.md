# NAME-ONLY NAVIGATION TEST: After Wave-3 Refactoring

**Repo**: caramel (audit/fixes-2026-07-10 @ 12d675f)  
**Date**: 2026-07-11  
**Test**: Empirical re-run after `shared-utils.js` split into coupon-apply, coupon-fetch, coupon-runner, store-detect, dom-utils, etc.

---

## PHASE 1+2: Locked Predictions vs. Verification

### Five Behaviors

| #   | Behavior                          | Predicted File                        | Actual File                                              | Result      | Notes                                                                                                                         |
| --- | --------------------------------- | ------------------------------------- | -------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Coupon reduced cart total         | `coupon-apply.js`                     | `coupon-runner.js` line 97-98                            | **WRONG**   | Split didn't help: moved from `shared-utils` → `coupon-runner`, not `coupon-apply`. Prediction would favor apply-layer logic. |
| 2   | New coupons created/submitted     | `/api/coupons/route.ts` (POST)        | Only GET handler; Python service                         | **PARTIAL** | No change from before. File path misleading; POST doesn't exist.                                                              |
| 3   | Extension detects store & fetches | `store-detect.js` + `coupon-fetch.js` | Both correct: `store-detect.js:22` + `coupon-fetch.js:8` | **HIT**     | Refactor improved clarity: `fetchCoupons` now in dedicated file.                                                              |
| 4   | Authentication configured         | `auth.ts`                             | `auth.ts` line 32: `betterAuth({...})`                   | **HIT**     | No change. Naming remains clear.                                                                                              |
| 5   | Transactional emails sent         | `email.ts`                            | `email.ts` line 21: `sendEmail`                          | **HIT**     | No change. Naming remains clear.                                                                                              |

**Behavior Score: 3 HIT + 1 PARTIAL + 1 WRONG = 60% HIT** (↑ from 40%)

---

### Ten Functions (Sampled)

| #   | Function              | Predicted Location  | Actual Location         | Result  |
| --- | --------------------- | ------------------- | ----------------------- | ------- |
| 1   | `applyCoupon`         | `coupon-apply.js`   | `coupon-apply.js:161`   | **HIT** |
| 2   | `fetchCoupons`        | `coupon-fetch.js`   | `coupon-fetch.js:8`     | **HIT** |
| 3   | `setInputValue`       | `coupon-apply.js`   | `coupon-apply.js:25`    | **HIT** |
| 4   | `detectCouponError`   | `coupon-apply.js`   | `coupon-apply.js:356`   | **HIT** |
| 5   | `getDomainRecord`     | `store-detect.js`   | `store-detect.js:22`    | **HIT** |
| 6   | `isCheckout`          | `store-detect.js`   | `store-detect.js:112`   | **HIT** |
| 7   | `classifyCart`        | `cartClassifier.ts` | `cartClassifier.ts:148` | **HIT** |
| 8   | `sendEmail`           | `email.ts`          | `email.ts:21`           | **HIT** |
| 9   | `chat`                | `openrouter.ts`     | `openrouter.ts:29`      | **HIT** |
| 10  | `removeAppliedCoupon` | `coupon-apply.js`   | `coupon-apply.js:39`    | **HIT** |

**Function Score: 10/10 HIT** (= 100%, sustained)

---

## Before vs. After Comparison

| Metric                    | Before        | After         | Change      |
| ------------------------- | ------------- | ------------- | ----------- |
| Behavior hits             | 2/5 (40%)     | 3/5 (60%)     | +20pp       |
| Function hits             | 10/10 (100%)  | 10/10 (100%)  | —           |
| Remaining wrong behaviors | 1 + 3 partial | 1 + 1 partial | Improvement |

**Key Insight**: The refactor (shared-utils split) improved behavior clarity for **store detection + coupon fetching** by separating them into dedicated files. However, **price-reduction logic** moved from a centralized but misnamed file to `coupon-runner.js`, which is harder to predict than `coupon-apply.js` would be. Files were split for _code organization_, not _naming clarity_.

---

## Remaining Naming Issues (After Refactoring)

### Still Misleading

1. **Behavior #2 - Coupon Creation Missing from File Tree**: The absence of a POST handler in `/api/coupons/route.ts` contradicts intuitive file naming. Developers still cannot discover the Python service mutation path from file names alone.
    - **Fix**: Add a pointer comment at the top of `couponsDb.ts` or in an API folder README, linking to architecture docs.

2. **Behavior #1 - Price Reduction in `coupon-runner.js`**: Name suggests orchestration/flow control, not price validation logic. A developer seeking "where price changed?" lands in `coupon-runner.js` by accident during loop execution, not by naming inference.
    - **Fix**: Rename to clarify purpose, or consolidate savings-logic into `coupon-apply.js`.

---

## Summary

- **Behavior navigation improved** (40% → 60%) but remains incomplete due to cross-process architecture.
- **Function-level navigation unchanged** (10/10): symbol names are reliably discoverable regardless of file boundaries.
- **Wave-3 refactoring (split files) helped** for store detection and coupon fetching, but did NOT resolve the price-reduction prediction gap.
