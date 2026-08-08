interface LoaderProps {
    label?: string
}

const Loader = ({ label }: LoaderProps) => {
    return (
        <div
            role="status"
            aria-live="polite"
            aria-label={label ?? 'Loading'}
            className="flex flex-col items-center gap-3"
        >
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-caramel/20 border-t-caramel dark:border-caramel/25 dark:border-t-caramelLight" />
            {label ? (
                <p className="text-sm font-semibold text-gray-600 dark:text-gray-300">
                    {label}
                </p>
            ) : null}
        </div>
    )
}

export default Loader
