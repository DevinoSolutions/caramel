'use client'
// src/components/support/SupportDialog.tsx
//
// The single, app-level support modal. Mounted once (near the Toaster in
// providers.tsx); it registers its opener on the module-level registry so
// promptSupportOnFailure — and any other caller — can open it without prop
// drilling. Built on the native <dialog> element (showModal/close, Escape via
// the browser's cancel/close events, automatic focus restore, backdrop-click
// close). No new component library.
import { useSession } from '@/lib/auth/client'
import {
    registerSupportDialogOpener,
    type SupportDialogOpenArgs,
} from '@/lib/feedback/supportDialogRegistry'
import { useCallback, useEffect, useRef, useState } from 'react'
import SupportForm from './support-form'

export default function SupportDialog() {
    const dialogRef = useRef<HTMLDialogElement>(null)
    const [args, setArgs] = useState<SupportDialogOpenArgs | null>(null)
    const { data: session } = useSession()
    const accountEmail = session?.user?.email ?? null

    const open = useCallback((next: SupportDialogOpenArgs) => {
        setArgs(next)
    }, [])

    // (De)register the opener for the module-level registry.
    useEffect(() => {
        registerSupportDialogOpener(open)
        return () => registerSupportDialogOpener(null)
    }, [open])

    // Drive the native modal from `args`: showModal traps focus + restores it
    // to the previously-focused element on close (browser-native).
    useEffect(() => {
        const dlg = dialogRef.current
        if (!dlg) return
        if (args && !dlg.open) dlg.showModal()
    }, [args])

    const close = useCallback(() => {
        dialogRef.current?.close()
        setArgs(null)
    }, [])

    // Backdrop click: pointer events on the ::backdrop target the <dialog>
    // element itself, so a target === dialog click means "outside the panel".
    const onDialogClick = (e: React.MouseEvent<HTMLDialogElement>) => {
        if (e.target === dialogRef.current) close()
    }

    return (
        <dialog
            ref={dialogRef}
            onClose={() => setArgs(null)}
            onClick={onDialogClick}
            className="w-[92vw] max-w-lg bg-transparent p-0 backdrop:bg-black/60 backdrop:backdrop-blur-sm"
        >
            {args ? (
                <div className="relative">
                    <button
                        type="button"
                        onClick={close}
                        aria-label="Close support form"
                        className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-lg font-bold text-gray-600 shadow transition hover:bg-white hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel dark:bg-gray-800/80 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
                    >
                        ×
                    </button>
                    <h2 className="mb-3 px-2 text-lg font-bold text-gray-900 dark:text-white">
                        Tell us what happened
                    </h2>
                    <SupportForm
                        accountEmail={accountEmail}
                        initialSentryEventId={args.initialSentryEventId}
                        fromRoute={args.fromRoute}
                        defaultType={args.defaultType ?? 'problem'}
                        onSubmitted={close}
                    />
                </div>
            ) : null}
        </dialog>
    )
}
