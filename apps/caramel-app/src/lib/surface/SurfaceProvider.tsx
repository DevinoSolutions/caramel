'use client'
// src/lib/surface/SurfaceProvider.tsx
//
// ONE resolution of "where is this visitor looking at Caramel from", shared by
// every install CTA and the growth-prompt orchestrator. Mounted once in
// app/providers.tsx. Starts at `'unknown'` on purpose: the server has no
// user-agent-specific render, so anything else here would be a hydration
// mismatch — consumers treat `'unknown'` as "not known YET" (see
// canAdvertiseInstall), never as "no surface".
//
// The extension's <html> stamp can land AFTER this effect runs (the content
// script runs at document_idle, hydration can win the race on a warm cache),
// so the stamp is observed, not just read once, and the window messages the
// content script posts are listened for as well.
import {
    detectBrowser,
    detectPlatform,
    type BrowserFamily,
    type DevicePlatform,
} from '@/lib/surface/detectPlatform'
import {
    detectSurface,
    EXTENSION_MESSAGE_TYPES,
    EXTENSION_STAMP_ATTRIBUTE,
    type Surface,
} from '@/lib/surface/detectSurface'
import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react'

export type SurfaceState = {
    surface: Surface | 'unknown'
    platform: DevicePlatform
    browser: BrowserFamily
    /** The stamped extension version, when the stamp is present. */
    extensionVersion: string | null
}

const UNRESOLVED: SurfaceState = {
    surface: 'unknown',
    platform: 'unknown',
    browser: 'other',
    extensionVersion: null,
}

const SurfaceContext = createContext<SurfaceState>(UNRESOLVED)

function readStamp(): string | null {
    return document.documentElement.getAttribute(EXTENSION_STAMP_ATTRIBUTE)
}

function readStandalone(): {
    displayModeStandalone: boolean
    navigatorStandalone: boolean
} {
    const mq = window.matchMedia?.(
        '(display-mode: standalone), (display-mode: window-controls-overlay)',
    )
    const nav = window.navigator as Navigator & { standalone?: boolean }
    return {
        displayModeStandalone: mq?.matches ?? false,
        navigatorStandalone: nav.standalone === true,
    }
}

export function SurfaceProvider({ children }: { children: ReactNode }) {
    const [stamp, setStamp] = useState<string | null>(null)
    const [messageSeen, setMessageSeen] = useState(false)
    const [resolved, setResolved] = useState(false)

    useEffect(() => {
        setStamp(readStamp())
        setResolved(true)

        const observer = new MutationObserver(() => setStamp(readStamp()))
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: [EXTENSION_STAMP_ATTRIBUTE],
        })

        const onMessage = (ev: MessageEvent) => {
            if (ev.origin !== window.location.origin) return
            const type = (ev.data as { type?: unknown } | null)?.type
            if (typeof type === 'string' && EXTENSION_MESSAGE_TYPES.has(type)) {
                setMessageSeen(true)
            }
        }
        window.addEventListener('message', onMessage)

        return () => {
            observer.disconnect()
            window.removeEventListener('message', onMessage)
        }
    }, [])

    const value = useMemo<SurfaceState>(() => {
        if (!resolved) return UNRESOLVED
        const ua = window.navigator.userAgent
        return {
            surface: detectSurface({
                extensionStamp: stamp,
                extensionMessageSeen: messageSeen,
                ...readStandalone(),
            }),
            platform: detectPlatform(ua, window.navigator.maxTouchPoints),
            browser: detectBrowser(ua),
            extensionVersion: stamp,
        }
    }, [resolved, stamp, messageSeen])

    return (
        <SurfaceContext.Provider value={value}>
            {children}
        </SurfaceContext.Provider>
    )
}

/** The resolved surface; `'unknown'` until the provider's effect has run. */
export function useSurface(): SurfaceState {
    return useContext(SurfaceContext)
}
