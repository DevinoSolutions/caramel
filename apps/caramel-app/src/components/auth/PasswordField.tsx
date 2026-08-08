'use client'

import {
    fieldErrorClasses,
    inputWithAffordanceClasses,
    labelClasses,
} from '@/components/auth/authStyles'
import { useId, useState } from 'react'
import { HiEye, HiEyeOff } from 'react-icons/hi'

type PasswordFieldProps = {
    label: string
    name: string
    /** `new-password` on signup/reset, `current-password` on login. */
    autoComplete: 'current-password' | 'new-password'
    placeholder?: string
    value?: string
    error?: string
    required?: boolean
    onChange?: React.ChangeEventHandler<HTMLInputElement>
    onBlur?: React.FocusEventHandler<HTMLInputElement>
    onFocus?: React.FocusEventHandler<HTMLInputElement>
    /** Rendered on the label row, e.g. the "Forgot password?" link. */
    trailingLabel?: React.ReactNode
}

/**
 * Password input with a reveal toggle.
 *
 * A typo in a masked field is the most common reason a correct password gets
 * rejected, and every field on these pages was previously mask-only with no way
 * to check. The toggle is a real <button> (not a div) so it is reachable by
 * keyboard, and it reports state through aria-pressed rather than icon alone.
 */
export default function PasswordField({
    label,
    name,
    autoComplete,
    placeholder,
    value,
    error,
    required,
    onChange,
    onBlur,
    onFocus,
    trailingLabel,
}: PasswordFieldProps) {
    const [revealed, setRevealed] = useState(false)
    const id = useId()
    const errorId = `${id}-error`

    return (
        <div>
            <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={id} className={labelClasses}>
                    {label}
                </label>
                {trailingLabel}
            </div>
            <div className="relative">
                <input
                    id={id}
                    name={name}
                    type={revealed ? 'text' : 'password'}
                    required={required}
                    autoComplete={autoComplete}
                    placeholder={placeholder}
                    value={value}
                    onChange={onChange}
                    onBlur={onBlur}
                    onFocus={onFocus}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    className={inputWithAffordanceClasses}
                />
                <button
                    type="button"
                    onClick={() => setRevealed(current => !current)}
                    aria-label={revealed ? 'Hide password' : 'Show password'}
                    aria-pressed={revealed}
                    className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-xl text-gray-500 transition hover:text-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel/50 dark:text-gray-400"
                >
                    {revealed ? (
                        <HiEyeOff aria-hidden="true" className="h-5 w-5" />
                    ) : (
                        <HiEye aria-hidden="true" className="h-5 w-5" />
                    )}
                </button>
            </div>
            {error ? (
                <p id={errorId} role="alert" className={fieldErrorClasses}>
                    {error}
                </p>
            ) : null}
        </div>
    )
}
