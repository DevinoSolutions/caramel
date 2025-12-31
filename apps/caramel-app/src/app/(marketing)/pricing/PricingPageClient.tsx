'use client'

import Doodles from '@/components/Doodles'
import PricingSection from '@/components/PricingSection'

export default function PricingPageClient() {
    return (
        <main className="relative -mt-[6.7rem] w-full overflow-x-clip">
            <Doodles />
            <div className="scroll-smooth">
                <PricingSection />
            </div>
        </main>
    )
}
