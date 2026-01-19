import '@testing-library/jest-dom'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import * as React from 'react'

// Cleanup after each test
afterEach(() => {
    cleanup()
})

// Mock Next.js router
vi.mock('next/navigation', () => ({
    useRouter: vi.fn(() => ({
        push: vi.fn(),
        replace: vi.fn(),
        prefetch: vi.fn(),
        back: vi.fn(),
    })),
    usePathname: vi.fn(() => '/'),
    useSearchParams: vi.fn(() => ({
        get: vi.fn(),
    })),
}))

// Mock Next.js Image component
vi.mock('next/image', () => ({
    default: ({ src, alt, ...props }: any) =>
        React.createElement('img', { src, alt, ...props }),
}))

// Mock better-auth client
vi.mock('@/lib/auth/client', () => ({
    useSession: vi.fn(() => ({
        data: null,
        isPending: false,
    })),
    signIn: {
        email: vi.fn(),
        social: vi.fn(),
    },
    signUp: {
        email: vi.fn(),
    },
    signOut: vi.fn(),
    authClient: {},
}))

// Mock framer-motion
vi.mock('framer-motion', () => ({
    motion: {
        div: ({ children, ...props }: any) =>
            React.createElement('div', props, children),
        button: ({ children, ...props }: any) =>
            React.createElement('button', props, children),
        a: ({ children, ...props }: any) =>
            React.createElement('a', props, children),
        span: ({ children, ...props }: any) =>
            React.createElement('span', props, children),
        h1: ({ children, ...props }: any) =>
            React.createElement('h1', props, children),
        h2: ({ children, ...props }: any) =>
            React.createElement('h2', props, children),
        p: ({ children, ...props }: any) =>
            React.createElement('p', props, children),
        create: (Component: any) => Component,
    },
    AnimatePresence: ({ children }: any) => children,
}))

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })),
})

// Mock ThemeToggle component
vi.mock('@/components/ThemeToggle', () => ({
    default: () => React.createElement('div', { 'data-testid': 'theme-toggle' }, 'ThemeToggle'),
}))

// Mock react-icons
vi.mock('react-icons/ri', () => ({
    RiMenu3Fill: () => React.createElement('svg', { 'data-testid': 'menu-icon' }),
    RiCloseFill: () => React.createElement('svg', { 'data-testid': 'close-icon' }),
    RiInstagramFill: () => React.createElement('svg', {}),
}))

// Mock hooks
vi.mock('@/hooks/useScrollDirection', () => ({
    useScrollDirection: vi.fn(() => ({
        isScrollingDown: false,
        isScrollingUp: true,
    })),
}))

vi.mock('@/hooks/useWindowSize', () => ({
    useWindowSize: vi.fn(() => ({
        windowSize: { width: 1024, height: 768 },
    })),
}))
