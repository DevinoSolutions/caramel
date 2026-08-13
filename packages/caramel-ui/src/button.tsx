import type { ButtonHTMLAttributes, ReactNode } from 'react'
import './button.css'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'ghost'
    children: ReactNode
}

/** Token-driven brand button. Host must load a `--cm-*` token sheet. */
export function Button({
    variant = 'primary',
    className,
    children,
    type,
    ...rest
}: ButtonProps) {
    const classes = ['cm-ui-button', `cm-ui-button--${variant}`, className]
        .filter(Boolean)
        .join(' ')
    return (
        <button type={type ?? 'button'} className={classes} {...rest}>
            {children}
        </button>
    )
}
