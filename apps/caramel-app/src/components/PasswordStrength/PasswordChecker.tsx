import PasswordItem from '@/components/PasswordStrength/PasswordItem'
import { passwordRules } from '@/lib/passwordRules'

interface PasswordCheckerProps {
    password: string
    confirmPassword: string
}

/**
 * The rules come from `@/lib/passwordRules` — the same source the signup and
 * reset-password schemas validate against. This list used to hard-code its own
 * copy of the policy and had already drifted from the schema (it ticked
 * "minimum length reached" at 5 characters), so a shopper could see every item
 * green and still have the form reject the password.
 */
const PasswordChecker = ({
    password,
    confirmPassword,
}: PasswordCheckerProps) => {
    const checkList = [
        ...passwordRules.map(rule => ({
            id: rule.id,
            term: rule.test(password),
            success_message: rule.success,
            failure_message: rule.failure,
        })),
        {
            id: 'match',
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
