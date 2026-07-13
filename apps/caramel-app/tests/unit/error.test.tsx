// @vitest-environment jsdom
// Aliased on import: the default export is named `Error`, which would
// shadow the global `Error` constructor this file also needs (to build
// fixture error objects) if imported under its own name.
import ErrorBoundary from '@/app/error'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// F-011 — the App-Router error boundary that previously didn't exist (an
// uncaught render throw fell through to Next's default, unbranded error
// page — see AM-12 in audit/empirical-3am.md). Pins: (1) the honest,
// branded fallback UI renders, (2) the error reaches Sentry via the
// canonical useEffect-capture pattern (F-002 already covers ROUTE errors;
// this is the separate render-error path), (3) `reset` is wired to the
// "Try again" button. jsdom-only file (CR-1) — the rest of the app unit
// suite runs in vitest's node environment (F-004).
const { captureExceptionMock } = vi.hoisted(() => ({
    captureExceptionMock: vi.fn(),
}))
vi.mock('@sentry/nextjs', () => ({
    captureException: captureExceptionMock,
}))

beforeEach(() => {
    captureExceptionMock.mockClear()
})

afterEach(() => {
    cleanup()
})

describe('app/error.tsx', () => {
    it('renders an honest, branded failure message (not a blank/generic page)', () => {
        render(<ErrorBoundary error={new Error('boom')} reset={vi.fn()} />)
        expect(
            screen.getByRole('heading', { name: /something went wrong/i }),
        ).toBeTruthy()
        expect(screen.getByText(/reported/i)).toBeTruthy()
    })

    it('reports the error to Sentry on mount', () => {
        const error = new Error('render exploded')
        render(<ErrorBoundary error={error} reset={vi.fn()} />)
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
        expect(captureExceptionMock).toHaveBeenCalledWith(error)
    })

    it('re-reports when a new error instance is passed (effect dep on `error`)', () => {
        const first = new Error('first')
        const { rerender } = render(
            <ErrorBoundary error={first} reset={vi.fn()} />,
        )
        expect(captureExceptionMock).toHaveBeenCalledTimes(1)

        const second = new Error('second')
        rerender(<ErrorBoundary error={second} reset={vi.fn()} />)
        expect(captureExceptionMock).toHaveBeenCalledTimes(2)
        expect(captureExceptionMock).toHaveBeenLastCalledWith(second)
    })

    it('calls reset() when "Try again" is clicked', () => {
        const resetMock = vi.fn()
        render(<ErrorBoundary error={new Error('boom')} reset={resetMock} />)
        fireEvent.click(screen.getByRole('button', { name: /try again/i }))
        expect(resetMock).toHaveBeenCalledTimes(1)
    })

    it('offers a link back home', () => {
        render(<ErrorBoundary error={new Error('boom')} reset={vi.fn()} />)
        const homeLink = screen.getByRole('link', { name: /go home/i })
        expect(homeLink.getAttribute('href')).toBe('/')
    })
})
