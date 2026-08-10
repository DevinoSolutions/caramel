import ProfileSection from '@/components/profile/ProfileSection'
import { microLabelClasses } from '@/lib/profile/profileStyles'

/**
 * The account's own fields.
 *
 * Presented as a two-column definition grid rather than the previous stack of
 * label-over-value pairs in an oversized card: at desktop width a single
 * column of short values left most of the card empty, which is what made it
 * read as a bare field dump. The grid collapses to one column on phones, where
 * a single column IS the right answer.
 *
 * Fields render only when they have a value, EXCEPT email (always shown, the
 * account's identity) — the original page's behaviour, preserved: a column of
 * "Not provided" rows is a form's idea of completeness, not information.
 *
 * The "Account details" heading is an E2E landmark (auth-flows.spec.ts waits
 * on it to prove an authenticated /profile rendered) — keep the exact string.
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
            <dl className="grid grid-cols-2 gap-x-8 gap-y-5 md:grid-cols-1 md:gap-y-4">
                {fields.map(field => (
                    <div key={field.label} className="min-w-0">
                        <dt className={microLabelClasses}>{field.label}</dt>
                        <dd className="mt-1 truncate text-gray-900 dark:text-gray-100">
                            {field.value}
                        </dd>
                    </div>
                ))}
            </dl>
        </ProfileSection>
    )
}
