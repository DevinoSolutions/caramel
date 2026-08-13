import { readdirSync, readFileSync } from 'node:fs'
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
// is exactly why the drift survived so long. P2 (2026-08-13): the markup moved
// from popup.js innerHTML into the React views, so the scan walks every TSX
// under entrypoints/popup plus popup-core.js (its status strings, e.g.
// 'Signing out…', are copy too). The old `<button …>label</button>` regex died
// with the move — JSX props hold arrow functions whose `=>` ends an [^>]*
// attribute match mid-tag — so labels are read as JSX text children instead.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function popupSources(dir = join(ROOT, 'entrypoints', 'popup')) {
    const files = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) files.push(...popupSources(full))
        else if (/\.(tsx|ts)$/.test(entry.name)) files.push(full)
    }
    return files
}

const src = [join(ROOT, 'popup-core.js'), ...popupSources()]
    .map(f => readFileSync(f, 'utf8'))
    .join('\n')

/** Every "log in/log out"-shaped label appearing as a JSX text child. */
const actionLabels = () =>
    [...src.matchAll(/>\s*(log\s?out|log\s?in)\s*</gi)].map(m => m[1].trim())

describe('popup copy — one spelling per action', () => {
    it('never uses the one-word "Logout" spelling', () => {
        expect(
            actionLabels().filter(
                t => /^log ?out$/i.test(t) && t !== 'Log out',
            ),
            'the sign-out button must read "Log out" everywhere',
        ).toEqual([])
    })

    it('never uses the one-word "Login" spelling', () => {
        expect(
            actionLabels().filter(t => /^log ?in$/i.test(t) && t !== 'Log in'),
            'the sign-in button must read "Log in" everywhere',
        ).toEqual([])
    })

    it('still renders both actions somewhere', () => {
        // Guards the guard: if the labels were renamed wholesale the two tests
        // above would pass vacuously.
        const labels = actionLabels()
        expect(labels).toContain('Log out')
        expect(labels).toContain('Log in')
    })
})
