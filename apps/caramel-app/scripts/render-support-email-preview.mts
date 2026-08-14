/**
 * Render the support-notification email to a file for visual inspection.
 *
 * Not part of the build or the test suite — a developer tool for eyeballing the
 * template the way a mail client will, which is the only way this class of bug
 * (a body that renders fine in code review and arrives as a wall of text) gets
 * caught before an operator sees it.
 *
 *   pnpm --filter caramel-app exec tsx scripts/render-support-email-preview.mts <out.html>
 */
import { render } from '@react-email/render'
import { writeFileSync } from 'node:fs'
import * as TemplateModule from '../emails/SupportNotificationTemplate'

// tsx loads this .tsx through CJS interop, which wraps the default export one
// or two levels deep (`default`, then `default.default`) depending on the
// resolver; under vitest it is the plain function. Unwrap until it is callable
// rather than guessing a fixed depth.
function unwrapDefault(mod: unknown): typeof TemplateModule.default {
    let candidate: unknown = mod
    for (let depth = 0; depth < 4; depth += 1) {
        if (typeof candidate === 'function') {
            return candidate as typeof TemplateModule.default
        }
        candidate = (candidate as { default?: unknown })?.default
    }
    throw new Error(
        'SupportNotificationTemplate default export is not callable',
    )
}

const SupportNotificationTemplate = unwrapDefault(TemplateModule)

// The real 2026-08-14 production submission (feedback id 0610c6dd-…), so the
// preview shows genuine content — multi-line message included — rather than
// lorem ipsum that would hide the line-break handling.
const html = await render(
    SupportNotificationTemplate({
        feedbackId: '0610c6dd-8dfe-4d75-9319-2044809345ac',
        feedbackType: 'problem',
        wantsReply: true,
        message:
            "The extension, no matter which website I visit just says \"Couldn't load coupons Check your connection and try again.\" \nNothing is wrong with my connection that I'm aware of and I'm not using any sort of VPN either.",
        expectedOutcome: undefined,
        appLabel: 'caramel v0.1.0',
        environment: 'production',
        platform: 'web',
        route: '/support',
        userLabel: '33ce6015-1d08-4195-a96d-e80f01ddaefb',
        posthogSessionId: '01a00045-caae-77f0-bc02-e7f836409f00',
        posthogDistinctId: '33ce6015-1d08-4195-a96d-e80f01ddaefb',
    }),
)

const out = process.argv[2]
if (!out) throw new Error('usage: render-support-email-preview.mts <out.html>')
writeFileSync(out, html, 'utf8')
console.log(`wrote ${out} (${Buffer.byteLength(html)} bytes)`)
