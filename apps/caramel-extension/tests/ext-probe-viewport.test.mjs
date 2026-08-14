// QA must run at the viewport the config was DERIVED at.
//
// `agent_discovery` drives its browser at `--viewport 1920x1080` and writes
// selectors against that DOM. The probe defaulted to 390x844, so every config
// was proven on a desktop layout and then graded on a phone one — a different
// DOM, frequently a different checkout, and a source of reds that were never
// about the config. Every ext-QA run before 2026-08-14 was measured that way.
//
// The default is therefore pinned here, not left to a literal in the middle of
// a 700-line driver where the next refactor can quietly restore a phone.
import { describe, expect, it } from 'vitest'
import {
    DESKTOP_VIEWPORT,
    MOBILE_HEIGHT,
    resolveViewport,
} from '../../../tools/ext-probe/viewport.mjs'

describe('the probe measures at the viewport discovery derived the config at', () => {
    it('defaults to 1920x1080 — the same pair agent_discovery passes', () => {
        expect(resolveViewport({})).toEqual({ width: 1920, height: 1080 })
        expect(DESKTOP_VIEWPORT).toEqual({ width: 1920, height: 1080 })
    })

    it('is NOT the old 390x844 phone default', () => {
        // The regression this pin exists for. A probe that silently goes back
        // to a phone viewport grades desktop-derived selectors against a DOM
        // that may not contain them at all.
        const v = resolveViewport({})
        expect(v.width).not.toBe(390)
        expect(v.height).not.toBe(MOBILE_HEIGHT)
    })

    it('takes --viewport WxH verbatim, in agent_discovery spelling', () => {
        expect(resolveViewport({ viewport: '1440x900' })).toEqual({
            width: 1440,
            height: 900,
        })
        // Whitespace and the unicode multiplication sign, because both turn up
        // in hand-typed invocations.
        expect(resolveViewport({ viewport: '1280 x 720' })).toEqual({
            width: 1280,
            height: 720,
        })
        expect(resolveViewport({ viewport: '1280×720' }).width).toBe(1280)
    })

    it('--width alone opts into a REAL phone, not a 390x1080 sliver', () => {
        expect(resolveViewport({ width: '390' })).toEqual({
            width: 390,
            height: MOBILE_HEIGHT,
        })
        // ...and the positional form the probe has always accepted behaves the
        // same, so the documented mobile pass is one argument either way.
        expect(resolveViewport({}, '390')).toEqual({
            width: 390,
            height: MOBILE_HEIGHT,
        })
    })

    it('a desktop-class width keeps the desktop height', () => {
        expect(resolveViewport({ width: '1440' }).height).toBe(1080)
    })

    it('--height overrides the class rule in both directions', () => {
        expect(resolveViewport({ width: '390', height: '1200' })).toEqual({
            width: 390,
            height: 1200,
        })
        expect(resolveViewport({ width: '1920', height: '600' }).height).toBe(
            600,
        )
    })

    it('--viewport outranks --width/--height, so one flag fully decides', () => {
        expect(
            resolveViewport({ viewport: '800x600', width: '390', height: '9' }),
        ).toEqual({ width: 800, height: 600 })
    })

    it('a malformed --viewport falls through to the desktop default rather than NaN', () => {
        // A NaN viewport reaches Playwright and fails deep inside the launch,
        // long after the useful error could have been printed.
        for (const bad of ['wide', '1920', '1920x', 'x1080', ''])
            expect(resolveViewport({ viewport: bad })).toEqual(DESKTOP_VIEWPORT)
    })
})
