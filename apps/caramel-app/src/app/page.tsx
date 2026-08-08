import Doodles from '@/components/Doodles'
import FaqSection from '@/components/FaqSection'
import FeaturesSection from '@/components/FeaturesSection'
import HeroSection from '@/components/HeroSection'
import HomeClientEffects from '@/components/HomeClientEffects'
import OpenSourceSection from '@/components/OpenSourceSection'
import SectionDivider from '@/components/SectionDivider'
import SupportedSection from '@/components/SupportedSection'
import WhyNotHoneySection from '@/components/WhyNot'
import type { Metadata } from 'next'
import { Suspense } from 'react'

export const metadata: Metadata = {
    alternates: { canonical: '/' },
}

// Server component on purpose. The sections below are still client components
// and still animate exactly as before — they just server-render their markup
// now, so crawlers get the h1, the copy and the internal links instead of an
// empty shell. Nothing client-only may be called HERE: the one thing that was
// (useSearchParams) now lives in <HomeClientEffects> behind Suspense, because
// calling it at page level opts the entire route out of server rendering.
export default function Page(): React.JSX.Element {
    return (
        <main className="relative -mt-[6.7rem] w-full overflow-x-clip">
            <Suspense fallback={null}>
                <HomeClientEffects />
            </Suspense>
            <Doodles />
            <div className="scroll-smooth">
                <HeroSection />
                <SectionDivider
                    lineClassName="bg-gradient-to-r from-transparent via-caramel/40 to-transparent"
                    glowClassName="bg-gradient-to-r from-transparent via-orange-500/20 to-transparent blur-sm"
                />
                <FeaturesSection />
                <SectionDivider
                    lineClassName="bg-gradient-to-r from-transparent via-orange-600/40 to-transparent"
                    glowClassName="bg-gradient-to-r from-transparent via-caramel/20 to-transparent blur-sm"
                />
                <SupportedSection />
                <SectionDivider
                    lineClassName="bg-gradient-to-r from-transparent via-orange-500/40 to-transparent"
                    glowClassName="bg-gradient-to-r from-transparent via-orange-300/20 to-transparent blur-sm"
                />
                <WhyNotHoneySection />
                <SectionDivider
                    lineClassName="bg-gradient-to-r from-transparent via-orange-500/40 to-transparent"
                    glowClassName="bg-gradient-to-r from-transparent via-orange-300/20 to-transparent blur-sm"
                />
                <OpenSourceSection />
                <SectionDivider
                    lineClassName="bg-gradient-to-r from-transparent via-caramel/40 to-transparent"
                    glowClassName="bg-gradient-to-r from-transparent via-orange-500/20 to-transparent blur-sm"
                />
                <FaqSection />
            </div>
        </main>
    )
}
