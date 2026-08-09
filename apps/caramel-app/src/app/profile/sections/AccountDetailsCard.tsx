import ProfileSection from '@/components/profile/ProfileSection'
import { cardClasses, microLabelClasses } from '@/lib/profile/profileStyles'

/**
 * The original profile page's field list, kept intact.
 *
 * It renders entirely from the session, so it is real content while the
 * overview is still loading — part of why this page no longer shows a
 * whole-page spinner.
 *
 * Fields render only when they have a value, EXCEPT email (always shown, the
 * account's identity) — the old page's behaviour, preserved: a column of "Not
 * provided" rows is a form's idea of completeness, not information.
 */
export default function AccountDetailsCard({
    user,
}: {
    user: {
        name?: string | null
        email?: string | null
        firstName?: string | null
        lastName?: string | null
        username?: string | null
    }
}) {
    const fields: { label: string; value: string }[] = [
        { label: 'Email', value: user.email || 'Not provided' },
    ]
    if (user.name) fields.push({ label: 'Name', value: user.name })
    if (user.firstName || user.lastName) {
        fields.push({
            label: 'First Name',
            value: user.firstName || 'Not provided',
        })
        fields.push({
            label: 'Last Name',
            value: user.lastName || 'Not provided',
        })
    }
    if (user.username) {
        fields.push({ label: 'Username', value: user.username })
    }

    return (
        <ProfileSection id="account" title="Account details">
            <div className={cardClasses}>
                <dl className="space-y-4">
                    {fields.map(field => (
                        <div key={field.label}>
                            <dt className={microLabelClasses}>{field.label}</dt>
                            <dd className="mt-1 break-words text-gray-900 dark:text-gray-100">
                                {field.value}
                            </dd>
                        </div>
                    ))}
                </dl>
            </div>
        </ProfileSection>
    )
}
