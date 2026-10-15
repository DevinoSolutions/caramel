import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    buildFunnelEvent,
    CODE_SHARE_FUNNEL_BROWSERS,
    CODE_SHARE_FUNNEL_STEP_REASONS,
    funnelReasonForSkipped,
} from '../code-share-funnel.js'
import { EXT_ROOT } from './_entry-modules.mjs'

/**
 * code-share-funnel.js — the vocabulary and the ALLOWLIST of the diagnostics
 * payload. The rule under test: the one constructor can only ever produce the
 * documented fields, from validated values, and refuses (throws) anything
 * else. Nothing here touches the network.
 */

const BASE = {
    store: 'example.com',
    extVersion: '1.4.14',
    browser: 'chrome',
    sharingPromptVersion: 1,
}

describe('buildFunnelEvent: the payload allowlist', () => {
    it('produces exactly the documented fields for a step without a reason', () => {
        expect(buildFunnelEvent({ step: 'capture_armed', ...BASE })).toEqual({
            step: 'capture_armed',
            store: 'example.com',
            extVersion: '1.4.14',
            browser: 'chrome',
            sharingPromptVersion: 1,
        })
    })

    it('carries the reason only on the steps that take one', () => {
        expect(
            buildFunnelEvent({
                step: 'submit_skipped',
                reason: 'signed-out',
                ...BASE,
            }),
        ).toEqual({
            step: 'submit_skipped',
            reason: 'signed-out',
            ...BASE,
        })
    })

    it('omits any field it was not built to carry: a code, user, URL or cart handed in never comes out', () => {
        const event = buildFunnelEvent({
            step: 'apply_observed',
            ...BASE,
            code: 'SAVE10',
            userId: 'u-1',
            email: 'a@b.co',
            url: 'https://example.com/cart?x=1',
            cart: ['shoes'],
        })
        expect(Object.keys(event).toSorted()).toEqual([
            'browser',
            'extVersion',
            'sharingPromptVersion',
            'step',
            'store',
        ])
        expect(JSON.stringify(event)).not.toMatch(
            /SAVE10|u-1|a@b\.co|cart|shoes/,
        )
    })

    it('throws on a step outside the vocabulary', () => {
        expect(() =>
            buildFunnelEvent({ step: 'sent_the_code', ...BASE }),
        ).toThrow(/unknown step/)
        expect(() => buildFunnelEvent({ step: undefined, ...BASE })).toThrow()
    })

    it('throws when a step that takes no reason gets one, or one that needs a reason lacks it', () => {
        expect(() =>
            buildFunnelEvent({
                step: 'capture_armed',
                reason: 'signed-out',
                ...BASE,
            }),
        ).toThrow(/takes no reason/)
        expect(() =>
            buildFunnelEvent({ step: 'submit_skipped', ...BASE }),
        ).toThrow(/needs a reason/)
    })

    it('throws on a reason that belongs to another step', () => {
        expect(() =>
            buildFunnelEvent({
                step: 'store_not_accepted',
                reason: 'signed-out',
                ...BASE,
            }),
        ).toThrow(/needs a reason/)
    })

    it.each([
        ['a URL', 'https://example.com/cart'],
        ['a path', 'example.com/cart'],
        ['a port', 'example.com:8080'],
        ['userinfo', 'a@example.com'],
        ['uppercase', 'Example.com'],
        ['a bare label', 'localhost'],
        ['an empty string', ''],
        ['whitespace', 'exa mple.com'],
        ['a non-string', 42],
    ])('refuses a store that is %s', (_label, store) => {
        expect(() =>
            buildFunnelEvent({ step: 'capture_armed', ...BASE, store }),
        ).toThrow(/store/)
    })

    it('refuses a missing store (the funnel is per store, never location-less)', () => {
        expect(() =>
            buildFunnelEvent({
                step: 'capture_armed',
                ...BASE,
                store: undefined,
            }),
        ).toThrow(/store/)
    })

    it('validates the version, browser and prompt version too', () => {
        expect(() =>
            buildFunnelEvent({
                step: 'capture_armed',
                ...BASE,
                extVersion: 'v1',
            }),
        ).toThrow(/extVersion/)
        expect(() =>
            buildFunnelEvent({
                step: 'capture_armed',
                ...BASE,
                browser: 'opera',
            }),
        ).toThrow(/browser/)
        expect(() =>
            buildFunnelEvent({
                step: 'capture_armed',
                ...BASE,
                sharingPromptVersion: 0,
            }),
        ).toThrow(/sharingPromptVersion/)
        for (const browser of CODE_SHARE_FUNNEL_BROWSERS)
            expect(
                buildFunnelEvent({ step: 'capture_armed', ...BASE, browser })
                    .browser,
            ).toBe(browser)
    })

    it('every step in the vocabulary can be built with each of its reasons', () => {
        for (const [step, reasons] of Object.entries(
            CODE_SHARE_FUNNEL_STEP_REASONS,
        )) {
            if (reasons.length === 0)
                expect(buildFunnelEvent({ step, ...BASE }).step).toBe(step)
            for (const reason of reasons)
                expect(buildFunnelEvent({ step, reason, ...BASE }).reason).toBe(
                    reason,
                )
        }
    })
})

describe('funnelReasonForSkipped: the worker gates mapped onto reasons', () => {
    it.each([
        ['signed-out', 'signed-out'],
        ['disabled', 'flag-off'],
        ['no-consent', 'no-consent'],
        ['consent-rejected', 'consent-rejected'],
        ['daily-limit', 'daily-limit'],
        ['rate-limited', 'rate-limited'],
        ['invalid-code', 'invalid-code'],
        ['not-a-store', 'not-a-store'],
    ])('%s -> %s', (skipped, reason) => {
        expect(funnelReasonForSkipped(skipped)).toBe(reason)
        expect(CODE_SHARE_FUNNEL_STEP_REASONS.submit_skipped).toContain(reason)
    })

    it('the card answers are already their own steps: no second event', () => {
        expect(funnelReasonForSkipped('consent-declined')).toBeNull()
        expect(funnelReasonForSkipped('consent-dismissed')).toBeNull()
    })

    it('server free text never reaches telemetry as text: it is "refused"', () => {
        expect(funnelReasonForSkipped('refused')).toBe('refused')
        expect(funnelReasonForSkipped('Invalid request body')).toBe('refused')
        expect(funnelReasonForSkipped('SAVE10 is not valid')).toBe('refused')
    })

    it('rejects a non-string loudly', () => {
        expect(() => funnelReasonForSkipped(undefined)).toThrow()
        expect(() => funnelReasonForSkipped('')).toThrow()
    })

    it('every `skipped:` value background.js can answer maps to a real submit_skipped reason (or the deliberate "refused")', () => {
        // Drift guard: a gate added to submitShopperCode without a mapping would
        // be reported as the generic "refused" and the funnel would blur.
        const source = readFileSync(join(EXT_ROOT, 'background.js'), 'utf8')
        const literals = new Set(
            [...source.matchAll(/skipped:\s*'([a-z-]+)'/g)].map(m => m[1]),
        )
        // The 429 branch spells its two values inside a ternary.
        literals.add('daily-limit')
        literals.add('rate-limited')
        expect(literals.size).toBeGreaterThan(5)
        for (const skipped of literals) {
            // The funnel handler's own answers are not submit gates.
            if (skipped === 'no-diagnostics-consent') continue
            const reason = funnelReasonForSkipped(skipped)
            if (skipped === 'refused') {
                expect(reason).toBe('refused')
                continue
            }
            expect(
                CODE_SHARE_FUNNEL_STEP_REASONS.submit_skipped,
                `${skipped} has no reason of its own`,
            ).toContain(reason)
            expect(reason, `${skipped} fell through to refused`).not.toBe(
                'refused',
            )
        }
    })
})
