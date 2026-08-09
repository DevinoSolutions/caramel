import ProfileSection from '@/components/profile/ProfileSection'
import {
    bodyTextClasses,
    cardClasses,
    subHeadingClasses,
} from '@/lib/profile/profileStyles'
import { selectReportTier, type ReportImpact } from '@/lib/profile/reportImpact'

// "Your reports" — impact without invented numbers.
//
// The whole section is a fall-through over what the backend can actually
// derive (see selectReportTier). The tier-C line names OTHER PEOPLE'S
// behaviour, so it renders only from a genuine downstream count and only at
// >= 10; below that it is technically true and rhetorically worse than
// silence, because it makes a real contribution sound trivial.
//
// The section HIDES ENTIRELY at zero reports. A block reading "you've made 0
// reports" is nag copy for a feature the user reaches from the extension, not
// from this page.
//
// CONTRAST: the numbers are `text-gray-900 dark:text-white`, NOT text-caramel.
// Bold body text at 16px does not clear the 18.66px-bold AA-large floor, so
// caramel numerals here would fail — caramel stays on the heading. This is
// flagged because the tempting version is the failing one.
//
// No list of individual reports: a user does not want to relive twelve "this
// code didn't work" submissions, and rendering them invites "why is this one
// still listed".

function Count({ children }: { children: React.ReactNode }) {
    return (
        <strong className="font-bold text-gray-900 dark:text-white">
            {children}
        </strong>
    )
}

export default function ReportsImpactSection({
    reports,
}: {
    reports: ReportImpact
}) {
    const tier = selectReportTier(reports)
    if (tier === 'none') return null

    const codes = (
        <Count>
            {reports.reportCount} {reports.reportCount === 1 ? 'code' : 'codes'}
        </Count>
    )

    return (
        <ProfileSection id="reports" title="Your reports">
            <div className={cardClasses}>
                <h3 className={subHeadingClasses}>
                    {tier === 'C'
                        ? 'Your reports are working'
                        : 'Thanks for reporting'}
                </h3>
                <p className={`${bodyTextClasses} mt-2`}>
                    {tier === 'A' ? (
                        <>
                            You&apos;ve told us about {codes}. Every report
                            makes the next shopper&apos;s checkout a little less
                            annoying.
                        </>
                    ) : tier === 'B' ? (
                        <>
                            You&apos;ve told us about {codes}, and{' '}
                            <Count>{reports.confirmedCount}</Count> matched what
                            we found when we checked. That&apos;s what keeps the
                            list honest.
                        </>
                    ) : (
                        <>
                            You&apos;ve told us about {codes}. Since then,{' '}
                            <Count>
                                {reports.shoppersHelped}{' '}
                                {reports.shoppersHelped === 1
                                    ? 'shopper'
                                    : 'shoppers'}
                            </Count>{' '}
                            used a code your report helped us get right.
                        </>
                    )}
                </p>
            </div>
        </ProfileSection>
    )
}
