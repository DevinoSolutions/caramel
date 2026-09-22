// @vitest-environment jsdom
import AgentSetupPill from '@/components/growth/AgentSetupPill'
import {
    AGENT_GUIDES,
    AGENT_SETUP_COPY_TEXT,
} from '@/lib/agentSetup/agentSetup.config'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
                name: 'Copy the Caramel agent setup prompt',
            }),
        )
        await waitFor(() =>
            expect(writeText).toHaveBeenCalledWith(AGENT_SETUP_COPY_TEXT),
        )
        expect(toastMock.success).toHaveBeenCalledWith(
            'Copied. Paste into any AI coding agent.',
        )
        expect(trackMock).toHaveBeenCalledWith({ surface: 'hero', agent: 'copy' })
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
})
