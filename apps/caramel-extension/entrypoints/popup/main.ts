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
 *
 * TODO(WXT-P2 React shell): interim boot. popup.js became popup-core.js
 * (logic only — every render deleted) and the React app that paints the views
 * lands in this same PR; until that commit the popup renders NOTHING past the
 * static loader. If you are reading this on main, the React shell was
 * dropped: that is a release blocker, not a cleanup item.
 */
import { initCaramelBase } from '../../caramel-base.js'
import { initCouponConstants } from '../../coupon-constants.generated.js'
import { initCouponRunner } from '../../coupon-runner.js'
import { capturePopupCallerId } from '../../popup-core.js'

initCouponConstants()
initCaramelBase()
initCouponRunner()
capturePopupCallerId()
