// @vitest-environment jsdom
import GrowthPromptHost from '@/components/growth/GrowthPromptHost'
import InstallSurfaceGate from '@/components/growth/InstallSurfaceGate'
import {
    PROMPT_SESSION_SHOWN_KEY,
    PROMPTS_ENABLED_KEY,
} from '@/lib/prompts/promptStorage'
import type { GrowthPromptDefinition } from '@/lib/prompts/registry'
import { EXTENSION_STAMP_ATTRIBUTE } from '@/lib/surface/detectSurface'
import { SurfaceProvider } from '@/lib/surface/SurfaceProvider'
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The runner + the shared card + the install gate, through the real
// SurfaceProvider: one prompt shows, is stamped before render, closes on
// dismiss with a recorded refusal, and never renders where the extension
// already is. Fleet growth-prompts spec §A/§B.

const { sessionState, trackMock } = vi.hoisted(() => ({
    sessionState: { data: null as null | { user: Record<string, unknown> } },
    trackMock: vi.fn(),
}))
vi.mock('@/lib/auth/client', () => ({
    useSession: () => ({ data: sessionState.data, refetch: vi.fn() }),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/' }))
vi.mock('@/lib/analytics/growthEvents', () => ({
    trackGrowthEvent: trackMock,
}))

const installPrompt: GrowthPromptDefinition = {
    id: 'install_extension',
    decide: context =>
        context.surface === 'web'
            ? { show: true }
            : { show: false, reason: 'not web' },
    content: () => ({
        title: 'Get Caramel for this browser',
        body: 'Codes apply themselves at checkout.',
        acceptLabel: 'Get the extension',
        acceptHref: 'https://example.test/store',
    }),
}

function mountHost() {
    return render(
        <SurfaceProvider>
            <InstallSurfaceGate>
                <a href="#install-extension">Install Extension</a>
            </InstallSurfaceGate>
            <GrowthPromptHost
                registrations={[installPrompt]}
                now={() => 1_800_000_000_000}
            />
        </SurfaceProvider>,
    )
}

beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    document.documentElement.removeAttribute(EXTENSION_STAMP_ATTRIBUTE)
    sessionState.data = null
    trackMock.mockClear()
})

afterEach(() => {
    cleanup()
    document.documentElement.removeAttribute(EXTENSION_STAMP_ATTRIBUTE)
})

describe('GrowthPromptHost', () => {
    it('shows the picked prompt in the shared card and stamps it before render', async () => {
        mountHost()

        const dialog = await screen.findByRole('dialog')
        expect(dialog.textContent).toContain('Get Caramel for this browser')
        expect(window.sessionStorage.getItem(PROMPT_SESSION_SHOWN_KEY)).toBe(
            '1',
        )
        expect(trackMock).toHaveBeenCalledWith(
            'prompt_shown',
            expect.objectContaining({
                prompt_id: 'install_extension',
                surface: 'web',
            }),
        )
    })

    it('records a dismissal, closes, and does not come back this session', async () => {
        const { unmount } = mountHost()
        await screen.findByRole('dialog')

        fireEvent.click(screen.getByRole('button', { name: 'Not now' }))

        expect(screen.queryByRole('dialog')).toBeNull()
        expect(
            window.localStorage.getItem(
                'caramel_prompt_install_extension_dismissals',
            ),
        ).toBe('1')
        expect(trackMock).toHaveBeenCalledWith(
            'prompt_dismissed',
            expect.objectContaining({ prompt_id: 'install_extension' }),
        )

        // A fresh mount in the same session (next page) stays quiet.
        unmount()
        mountHost()
        await act(async () => {})
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('reports an accept', async () => {
        mountHost()
        await screen.findByRole('dialog')

        fireEvent.click(screen.getByRole('link', { name: 'Get the extension' }))

        expect(trackMock).toHaveBeenCalledWith(
            'prompt_accepted',
            expect.objectContaining({ prompt_id: 'install_extension' }),
        )
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('honours the signed-out kill switch mirror', async () => {
        window.localStorage.setItem(PROMPTS_ENABLED_KEY, '0')
        mountHost()
        await act(async () => {})
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('honours the account setting when signed in, and mirrors it locally', async () => {
        sessionState.data = { user: { id: 'u1', growthPromptsEnabled: false } }
        mountHost()
        await act(async () => {})
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(window.localStorage.getItem(PROMPTS_ENABLED_KEY)).toBe('0')
    })

    it('shows nothing, and hides every install CTA, when the extension is present', async () => {
        document.documentElement.setAttribute(
            EXTENSION_STAMP_ATTRIBUTE,
            '1.4.1',
        )
        mountHost()
        await act(async () => {})

        expect(screen.queryByRole('dialog')).toBeNull()
        expect(screen.queryByText('Install Extension')).toBeNull()
    })

    it('drops the install CTA when the extension announces itself after hydration', async () => {
        mountHost()
        expect(await screen.findByText('Install Extension')).not.toBeNull()

        await act(async () => {
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: { type: 'caramel-ext-present', version: '1.4.1' },
                    origin: window.location.origin,
                }),
            )
        })

        await waitFor(() =>
            expect(screen.queryByText('Install Extension')).toBeNull(),
        )
    })

    it('ignores a presence message from another origin', async () => {
        mountHost()
        await screen.findByText('Install Extension')

        await act(async () => {
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: { type: 'caramel-ext-present' },
                    origin: 'https://evil.example',
                }),
            )
        })

        expect(screen.queryByText('Install Extension')).not.toBeNull()
    })
})
