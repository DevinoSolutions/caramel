'use client'
// src/components/growth/InstallSurfaceGate.tsx
//
// Wraps every piece of UI that tells the visitor to get the Caramel extension
// (hero button, browser-store slab, sidebar store card, profile checklist
// step). Renders nothing once the surface says the extension is already here
// — fleet growth-prompts spec §A, "nothing that advertises the app may render
// where the app already is".
//
// The wrapper also carries `data-growth="install"`, which globals.css hides
// the instant `<html data-caramel-extension>` is present — that covers the
// pre-hydration window in which React has not yet learned the surface.
import { canAdvertiseInstall } from '@/lib/surface/detectSurface'
import { useSurface } from '@/lib/surface/SurfaceProvider'
import type { ReactNode } from 'react'

export const INSTALL_SURFACE_MARKER = 'install'

export default function InstallSurfaceGate({
    children,
    className,
}: {
    children: ReactNode
    /** Applied to the wrapper — pass the layout classes the child relied on
     * from its former parent so the gate is invisible to the layout. */
    className?: string
}) {
    const { surface } = useSurface()
    if (!canAdvertiseInstall(surface)) return null
    return (
        <div data-growth={INSTALL_SURFACE_MARKER} className={className}>
            {children}
        </div>
    )
}
