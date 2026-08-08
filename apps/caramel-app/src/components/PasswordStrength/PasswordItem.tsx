interface PasswordItemChecker {
    term: boolean
    success_message: string
    failure_message: string
}

interface PasswordItemProps {
    itemChecker: PasswordItemChecker
}

const PasswordItem = ({ itemChecker }: PasswordItemProps) => {
    return (
        <>
            <div
                className={`rounded-full fill-current p-1 transition-colors ${
                    itemChecker.term
                        ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400'
                        : 'bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-400'
                } `}
            >
                <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                >
                    <path
                        visibility={itemChecker.term ? 'visible' : 'hidden'}
                        d="M5 13l4 4L19 7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                    />
                    <path
                        visibility={!itemChecker.term ? 'visible' : 'hidden'}
                        d="M6 18L18 6M6 6l12 12"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                    />
                </svg>
            </div>
            <span
                className={`ml-2.5 text-sm font-medium transition-colors ${
                    itemChecker.term
                        ? 'text-green-700 dark:text-green-400'
                        : 'text-red-600 dark:text-red-400'
                } `}
            >
                {itemChecker.term
                    ? itemChecker.success_message
                    : itemChecker.failure_message}
            </span>
        </>
    )
}
export default PasswordItem
