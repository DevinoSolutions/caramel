/**
 * The popup realm's composition (WXT P1, 2026-08-12; React shell P2,
 * 2026-08-13) — successor to the ten <script> tags the vanilla index.html
 * carried. Init order = the old script order's effect order: env stamp
 * (module graph — caramel-env.js), constants, base, …, runner (yes, the
 * popup page registers coupon-runner's listeners today, so it keeps doing
 * so), then the popup's own boot: the callerId capture MUST precede the
 * first render (pinned — the caller relay reads it on login success), and
 * React owns everything the old DOMContentLoaded handler painted.
 *
 * NO cart-signals and NO inject in this realm — same as the old page.
 */
import { createRoot } from 'react-dom/client'
import { initCaramelBase } from '../../caramel-base.js'
import { initCouponConstants } from '../../coupon-constants.generated.js'
import { initCouponRunner } from '../../coupon-runner.js'
import { capturePopupCallerId } from '../../popup-core.js'
import { App } from './App'

initCouponConstants()
initCaramelBase()
initCouponRunner()
capturePopupCallerId()

const root = document.getElementById('root')
if (!root) throw new Error('popup index.html lost its #root mount point')
createRoot(root).render(<App />)
