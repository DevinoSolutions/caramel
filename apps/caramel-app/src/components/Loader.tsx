interface LoaderProps {
    label?: string
}

const Loader = ({ label }: LoaderProps) => {
    return (
        <div className="flex flex-col items-center gap-3">
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-orange-100 border-t-orange-500 dark:border-orange-900 dark:border-t-orange-400" />
            {label ? (
                <p className="text-sm font-semibold text-gray-600 dark:text-gray-300">
                    {label}
                </p>
            ) : null}
        </div>
    )
}

export default Loader
