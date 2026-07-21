'use client'
// src/lib/feedback/supportDialogRegistry.ts
//
// A tiny module-level registry that lets non-React code (promptSupportOnFailure)
// open the single app-level SupportDialog without prop-drilling or a context
// library. SupportDialog registers its opener on mount; any caller invokes
// `openSupportDialog(...)`. If no dialog is mounted yet, the call is a safe
// no-op (returns false) — the toast action simply does nothing rather than
// throwing.
export interface SupportDialogOpenArgs {
    /** Sentry event id to correlate this report with (from an error prompt). */
    initialSentryEventId?: string
    /** The route the user was on when the failure happened. */
    fromRoute?: string
    /** Pre-selected feedback type — 'problem' when opened from a failure. */
    defaultType?: 'problem' | 'feature_request' | 'question' | 'other'
}

type Opener = (args: SupportDialogOpenArgs) => void

let registeredOpener: Opener | null = null

/** Called by SupportDialog on mount/unmount to (de)register its opener. */
export function registerSupportDialogOpener(opener: Opener | null): void {
    registeredOpener = opener
}

/** Open the app-level support dialog. Returns false if none is mounted. */
export function openSupportDialog(args: SupportDialogOpenArgs = {}): boolean {
    if (!registeredOpener) return false
    registeredOpener(args)
    return true
}
