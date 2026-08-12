/**
 * The popup realm's composition (WXT P1, 2026-08-12) — successor to the ten
 * <script> tags the vanilla index.html carried. Init order = the old script
 * order's effect order: env stamp (module graph — caramel-env.js), constants,
 * base, …, runner (yes, the popup page registers coupon-runner's listeners
 * today, so it keeps doing so), then the popup's own entry. This file is a
 * plain page script, not a WXT entrypoint module — it runs only in the
 * browser, so top-level calls are safe here.
 *
 * NO cart-signals and NO inject in this realm — same as the old page.
 */
import { initCaramelBase } from '../../caramel-base.js'
import { initCouponConstants } from '../../coupon-constants.generated.js'
import { initCouponRunner } from '../../coupon-runner.js'
import { initPopupEntry } from '../../popup.js'

initCouponConstants()
initCaramelBase()
initCouponRunner()
initPopupEntry()
