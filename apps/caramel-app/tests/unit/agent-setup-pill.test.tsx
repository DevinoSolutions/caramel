// @vitest-environment jsdom
import AgentSetupPill from '@/components/growth/AgentSetupPill'
import {
    AGENT_GUIDES,
    AGENT_SETUP_COPY_TEXT,
} from '@/lib/agentSetup/agentSetup.config'
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The pill copies EXACTLY the manifest sentence, toasts, and reports which
// surface it was used on (fleet agent-onboarding spec §1).

const { trackMock, toastMock, writeText } = vi.hoisted(() => ({
    trackMock: vi.fn(),
    toastMock: { success: vi.fn(), error: vi.fn() },
    writeText: vi.fn(async () => undefined),
}))
vi.mock('@/lib/analytics/agentSetupEvents', () => ({
    trackAgentSetupCopied: trackMock,
}))
vi.mock('sonner', () => ({ toast: toastMock }))

describe('AgentSetupPill', () => {
    beforeEach(() => {
        trackMock.mockReset()
        toastMock.success.mockReset()
        toastMock.error.mockReset()
        writeText.mockClear()
        Object.defineProperty(window.navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })
    })
    afterEach(() => cleanup())

    it('copies the exact sentence, toasts, and fires agent_setup_copied for the surface', async () => {
        render(<AgentSetupPill surface="hero" />)
        fireEvent.click(
            screen.getByRole('button', {
                name: 'Onboard your agent to Caramel: copy the setup prompt',
            }),
        )
        await waitFor(() =>
            expect(writeText).toHaveBeenCalledWith(AGENT_SETUP_COPY_TEXT),
        )
        expect(toastMock.success).toHaveBeenCalledWith(
            'Copied. Paste into any AI coding agent.',
        )
        expect(trackMock).toHaveBeenCalledWith({
            surface: 'hero',
            agent: 'copy',
        })
    })

    it('reports a denied clipboard with an error toast and no conversion event', async () => {
        writeText.mockRejectedValueOnce(new Error('denied'))
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined)
        render(<AgentSetupPill surface="hero" />)
        fireEvent.click(
            screen.getByRole('button', {
                name: 'Onboard your agent to Caramel: copy the setup prompt',
            }),
        )
        await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1))
        expect(toastMock.success).not.toHaveBeenCalled()
        expect(trackMock).not.toHaveBeenCalled()
        consoleError.mockRestore()
    })

    it('links one chip per agent guide and reports which one was opened', () => {
        render(<AgentSetupPill surface="apps" />)
        for (const guide of AGENT_GUIDES) {
            const link = screen.getByRole('link', {
                name: `${guide.name} setup guide`,
            })
            expect(link.getAttribute('href')).toBe(`/agent-setup/${guide.id}`)
        }
        fireEvent.click(
            screen.getByRole('link', { name: 'Claude Code setup guide' }),
        )
        expect(trackMock).toHaveBeenCalledWith({
            surface: 'apps',
            agent: 'claude-code',
        })
    })

    it("draws each chip with that agent's own brand mark, never a monogram", () => {
        render(<AgentSetupPill surface="hero" />)
        // Path prefixes of the Lobe Icons marks (owner request 2026-10-09):
        // a swapped or generic glyph changes the first command of the path.
        const markPrefix: Record<string, string> = {
            'claude-code': 'M20.998 10.949H24v3.102',
            codex: 'M8.086.457a6.105 6.105',
            cursor: 'M22.106 5.68L12.5.135',
            opencode: 'M16 6H8v12h8V6zm4 16H4V2h16v20z',
            'github-copilot': 'M19.245 5.364c1.322 1.36',
        }
        for (const guide of AGENT_GUIDES) {
            const link = screen.getByRole('link', {
                name: `${guide.name} setup guide`,
            })
            const svg = link.querySelector(`svg[data-agent-icon="${guide.id}"]`)
            expect(svg?.getAttribute('aria-hidden')).toBe('true')
            expect(svg?.getAttribute('fill')).toBe('currentColor')
            expect(svg?.querySelector('path')?.getAttribute('d')).toMatch(
                new RegExp(`^${escapeRegExp(markPrefix[guide.id])}`),
            )
            // The retired two-letter monograms (Cu, Oc) are gone.
            expect(link.textContent).toBe('')
        }
    })
})

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
