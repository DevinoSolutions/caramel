import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The popup renders the same two actions from several different views, and the
// wording had drifted apart: the empty-state / unsupported-site view said
// "Log out" and "Log in" while the coupons view said "Logout" and "Login", so
// which spelling a user saw depended on whether the site they were on happened
// to have coupons. Same button, same action, two spellings.
//
// This is a static check on the source rather than a rendered one because the
// views are mutually exclusive — no single rendered popup can show both, which
// is exactly why the drift survived so long.
const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'popup.js'),
    'utf8',
)

/** Visible label text of every <button> literal in the popup's markup. */
const buttonLabels = () =>
    [...src.matchAll(/<button\b[^>]*>([^<]+)<\/button>/g)].map(m => m[1].trim())

describe('popup copy — one spelling per action', () => {
    it('never uses the one-word "Logout" spelling', () => {
        expect(
            buttonLabels().filter(
                t => /^log ?out$/i.test(t) && t !== 'Log out',
            ),
            'the sign-out button must read "Log out" everywhere',
        ).toEqual([])
    })

    it('never uses the one-word "Login" spelling', () => {
        expect(
            buttonLabels().filter(t => /^log ?in$/i.test(t) && t !== 'Log in'),
            'the sign-in button must read "Log in" everywhere',
        ).toEqual([])
    })

    it('still renders both actions somewhere', () => {
        // Guards the guard: if the labels were renamed wholesale the two tests
        // above would pass vacuously.
        const labels = buttonLabels()
        expect(labels).toContain('Log out')
        expect(labels).toContain('Log in')
    })
})
