import PasswordItem from '@/components/PasswordStrength/PasswordItem'

interface PasswordCheckerProps {
    password: string
    confirmPassword: string
}

const PasswordChecker = ({
    password,
    confirmPassword,
}: PasswordCheckerProps) => {
    const checkList = [
        {
            id: 1,
            term: password.length >= 5,
            success_message: 'The minimum length is reached',
            failure_message: 'At least 5 characters required',
        },
        {
            id: 2,
            term: /[A-Z]/.test(password),
            success_message: 'At least one uppercase letter',
            failure_message: 'At least one uppercase letter required',
        },
        {
            id: 3,
            term: /[0-9]/.test(password),
            success_message: 'At least one number',
            failure_message: 'At least one number required',
        },
        {
            id: 4,
            term: /[!@#$%^&*+-]/.test(password),
            success_message: 'At least special character',
            failure_message: 'At least special character required',
        },
        {
            id: 5,
            term: password === confirmPassword && password.length > 0,
            success_message: 'Passwords match',
            failure_message: 'Passwords must match',
        },
    ]

    return (
        <div className="w-full rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-darkBg">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Password requirements
            </p>
            <ul className="grid w-full grid-cols-1 gap-1.5">
                {checkList.map(itemChecker => (
                    <li className="flex items-center" key={itemChecker.id}>
                        <PasswordItem itemChecker={itemChecker} />
                    </li>
                ))}
            </ul>
        </div>
    )
}

export default PasswordChecker
