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
        <div className="flex w-full justify-start">
            <ul className="mt-5 grid w-full grid-cols-1 gap-2 xl:grid-cols-2 lg:grid-cols-2 sm:grid-cols-1">
                {checkList.map(itemChecker => (
                    <li
                        className="flex items-center py-1 pl-3"
                        key={itemChecker.id}
                    >
                        <PasswordItem itemChecker={itemChecker} />
                    </li>
                ))}
            </ul>
        </div>
    )
}

export default PasswordChecker
