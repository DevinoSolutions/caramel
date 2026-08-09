'use client'

// inputClasses/primaryButtonClasses come straight from authStyles: the confirm
// input IS the same control as an auth input, and a second copy is exactly the
// drift authStyles.ts was created to end.
import {
    inputClasses,
    primaryButtonClasses,
} from '@/components/auth/authStyles'
import {
    cardClasses,
    dangerButtonClasses,
    secondaryButtonClasses,
    subHeadingClasses,
} from '@/lib/profile/profileStyles'
import { useEffect, useId, useRef, useState } from 'react'

/**
 * Confirmation modal built on the native <dialog>, with the same mechanics as
 * SupportDialog: `showModal()` gives focus trap, Escape, and focus restore for
 * free, and a click whose target IS the dialog element (rather than the panel
 * inside it) is a backdrop click.
 *
 * `typeToConfirm` keeps the confirm button disabled until the user types the
 * exact string. It is `DELETE`, not the account's email address: typing your
 * own email is punishing on a phone keyboard, and this page's mobile entry
 * point is the extension popup.
 *
 * Focus lands on the INPUT, never on the destructive button — a dialog that
 * opens with "Delete" focused is one Enter keypress from an accident.
 */
export default function ConfirmDialog({
    open,
    onClose,
    onConfirm,
    title,
    body,
    confirmLabel,
    typeToConfirm,
    tone = 'default',
    busy,
}: {
    open: boolean
    onClose: () => void
    onConfirm: () => void | Promise<void>
    title: string
    body: React.ReactNode
    confirmLabel: string
    /** When set, the confirm button stays disabled until the user types this
     * exact string. */
    typeToConfirm?: string
    tone?: 'default' | 'danger'
    busy?: boolean
}) {
    const dialogRef = useRef<HTMLDialogElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const [typed, setTyped] = useState('')
    const headingId = useId()
    const promptId = useId()

    useEffect(() => {
        const dlg = dialogRef.current
        if (!dlg) return
        if (open && !dlg.open) {
            setTyped('')
            dlg.showModal()
            // showModal focuses the first tabbable child; for a destructive
            // dialog that must be the text input, so steer it explicitly.
            inputRef.current?.focus()
        }
        if (!open && dlg.open) dlg.close()
    }, [open])

    const confirmDisabled =
        busy || (typeToConfirm !== undefined && typed !== typeToConfirm)

    return (
        <dialog
            ref={dialogRef}
            onClose={onClose}
            onClick={e => {
                if (e.target === dialogRef.current) onClose()
            }}
            aria-labelledby={headingId}
            className="w-[92vw] max-w-md bg-transparent p-0 backdrop:bg-black/60 backdrop:backdrop-blur-sm"
        >
            {open ? (
                <div className={cardClasses}>
                    <h2 id={headingId} className={subHeadingClasses}>
                        {title}
                    </h2>
                    <div className="mt-3">{body}</div>

                    {typeToConfirm !== undefined ? (
                        <div className="mt-5">
                            <label
                                htmlFor={`${promptId}-input`}
                                className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"
                            >
                                Type {typeToConfirm} to confirm.
                            </label>
                            <input
                                ref={inputRef}
                                id={`${promptId}-input`}
                                type="text"
                                autoComplete="off"
                                value={typed}
                                onChange={e => setTyped(e.target.value)}
                                className={inputClasses}
                            />
                        </div>
                    ) : null}

                    <div className="mt-6 flex items-center justify-end gap-3 md:flex-col-reverse md:items-stretch">
                        <button
                            type="button"
                            onClick={onClose}
                            className={secondaryButtonClasses}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => void onConfirm()}
                            disabled={confirmDisabled}
                            className={
                                tone === 'danger'
                                    ? dangerButtonClasses
                                    : `${primaryButtonClasses} w-auto px-4 py-2.5 text-sm`
                            }
                        >
                            {confirmLabel}
                        </button>
                    </div>
                </div>
            ) : null}
        </dialog>
    )
}
