import GlobalError from '@/app/global-error'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// F-011 — global-error.tsx is the last-resort boundary (fires only when the
// ROOT layout itself throws) and must render its own <html>/<body> because
// it REPLACES the root layout (Next.js requirement — see
// PLAN-F-011.md §Approach "Error boundary"). renderToStaticMarkup exercises
// this WITHOUT jsdom: it's a structure assertion only, since SSR never runs
// effects — the identical useEffect(() => Sentry.captureException(error))
// pattern is already pinned once (with effects actually running, via RTL)
// in error.test.tsx; re-verifying it here would cost a jsdom environment
// for a file that otherwise doesn't need one.
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))

describe('app/global-error.tsx', () => {
    it('renders its own <html> and <body> (required — it replaces the root layout)', () => {
        const markup = renderToStaticMarkup(
            <GlobalError error={new Error('boom')} reset={() => {}} />,
        )
        expect(markup.startsWith('<html')).toBe(true)
        expect(markup).toContain('<body>')
    })

    it('renders the honest, branded failure message + reset button + home link', () => {
        const markup = renderToStaticMarkup(
            <GlobalError error={new Error('boom')} reset={() => {}} />,
        )
        expect(markup).toMatch(/something went wrong/i)
        expect(markup).toContain('Try again')
        expect(markup).toContain('href="/"')
    })

    it('uses inline styles only — no external class/stylesheet dependency (the root layout that would supply one is not rendered)', () => {
        const markup = renderToStaticMarkup(
            <GlobalError error={new Error('boom')} reset={() => {}} />,
        )
        expect(markup).not.toContain('class=')
        expect(markup).toContain('style=')
    })
})
