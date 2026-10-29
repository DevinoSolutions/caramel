// @vitest-environment jsdom
//
// T-10055: an app-shell visit registers the shell's platform, version and
// build as PostHog super properties, so a bounce loop can be tied to a build.
import { render } from '@testing-library/react'
import type { PostHog } from 'posthog-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const posthogTasks: Array<(posthog: PostHog) => void> = []

vi.mock('@/lib/analytics/posthogBrowser', () => ({
    withPosthog: (task: (posthog: PostHog) => void) => {
        posthogTasks.push(task)
    },
}))

import { SurfaceProvider } from '@/lib/surface/SurfaceProvider'

function setUserAgent(userAgent: string): void {
    Object.defineProperty(window.navigator, 'userAgent', {
        value: userAgent,
        configurable: true,
    })
}

function registeredProperties(): Array<Record<string, string>> {
    const register = vi.fn()
    for (const task of posthogTasks) task({ register } as unknown as PostHog)
    return register.mock.calls.map(call => call[0] as Record<string, string>)
}

describe('SurfaceProvider: app-shell super properties', () => {
    beforeEach(() => {
        posthogTasks.length = 0
    })
    afterEach(() => {
        setUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
    })

    it('registers platform, shell version and build', () => {
        setUserAgent(
            'Mozilla/5.0 (iPhone) Mobile/15E148 CaramelApp/1.6.0 (ios) CaramelBuild/42',
        )
        render(<SurfaceProvider>x</SurfaceProvider>)
        expect(registeredProperties()).toEqual([
            {
                surface: 'app-shell',
                app_platform: 'ios',
                app_shell_version: '1.6.0',
                app_build: '42',
            },
        ])
    })

    it('registers nothing outside the app shell', () => {
        setUserAgent('Mozilla/5.0 (iPhone) Mobile/15E148 Safari/604.1')
        render(<SurfaceProvider>x</SurfaceProvider>)
        expect(registeredProperties()).toEqual([])
    })
})
