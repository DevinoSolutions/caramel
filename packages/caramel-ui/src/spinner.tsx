import './spinner.css'

export interface SpinnerProps {
    /** Accessible label announced to screen readers. */
    label?: string
    /** Pixel diameter (default 24). */
    size?: number
}

/** Token-driven loading spinner. Host must load a `--cm-*` token sheet. */
export function Spinner({ label = 'Loading…', size = 24 }: SpinnerProps) {
    return (
        <span
            className="cm-ui-spinner"
            role="status"
            aria-label={label}
            style={size === 24 ? undefined : { width: size, height: size }}
        />
    )
}
