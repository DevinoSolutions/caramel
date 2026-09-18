// scripts/email-delivery-health.ts
//
// One-shot, on-demand run of the async email-delivery check that
// src/lib/emailDeliveryHealthMonitor.ts otherwise runs on an interval inside the
// server process. Same core (src/lib/emailDeliveryHealth.ts), same PII-free
// output — this is the ops handle for "did our mail actually get delivered?"
// without waiting for the next interval or reading a Sentry issue.
//
// Run it from INSIDE the prod container, where USESEND_* already exist:
//
//   docker exec <web-container> sh -lc 'cd apps/caramel-app && \
//     pnpm exec tsx scripts/email-delivery-health.ts --minutes 1440'
//
// or locally with the vars exported. Exit code is the verdict: 0 healthy or
// skipped, 1 degraded (failures / stuck sends) or unreachable — so a human, a
// Dokploy schedule or an Uptime-Kuma push monitor can all consume it.
//
// It deliberately reads process.env directly instead of importing @/lib/env:
// this runs in contexts (an ops shell, a maintenance container) that have the
// email vars but not necessarily DATABASE_URL, and a health check must not be
// blocked by an unrelated env contract.
import {
    checkEmailDeliveryHealth,
    DEFAULT_WINDOW_MINUTES,
    formatEmailDeliveryHealthLine,
} from '@/lib/emailDeliveryHealth'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** `--minutes 1440` / `--minutes=1440`; falls back to the default window. */
export function parseWindowMinutes(argv: readonly string[]): number {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const inline = /^--minutes=(\d+)$/.exec(arg)
        if (inline) return Number(inline[1])
        if (arg === '--minutes' && argv[i + 1] && /^\d+$/.test(argv[i + 1])) {
            return Number(argv[i + 1])
        }
    }
    return DEFAULT_WINDOW_MINUTES
}

async function main() {
    const windowMinutes = parseWindowMinutes(process.argv.slice(2))
    const report = await checkEmailDeliveryHealth({
        baseUrl: process.env.USESEND_BASE_URL ?? '',
        apiKey: process.env.USESEND_API_KEY ?? '',
        fromEmail: process.env.USESEND_FROM_EMAIL,
        windowMinutes,
    })
    console.log(formatEmailDeliveryHealthLine(report))
    if (report.status === 'degraded' || report.status === 'error') {
        process.exit(1)
    }
}

const isDirectExecution =
    process.argv[1] &&
    path.resolve(process.argv[1]) ===
        path.resolve(fileURLToPath(import.meta.url))

if (isDirectExecution) {
    main().catch(err => {
        console.error('[email-health] Unexpected failure:', err)
        process.exit(1)
    })
}
