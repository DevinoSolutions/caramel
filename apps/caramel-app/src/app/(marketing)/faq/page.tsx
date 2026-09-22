import FaqSection from '@/components/FaqSection'
import { BASE_URL } from '@/lib/env.client'
import { faqItems } from '@/lib/faqItems'
import type { Metadata } from 'next'

// /faq — the landing FAQ at its own URL (fleet agent-onboarding spec §4:
// "/faq on the app domain … If no FAQ exists, create one"). Caramel has no
// docs host, so this IS the docs FAQ; faq.grabcaramel.com redirects here at
// the edge (Cloudflare redirect rule, zone grabcaramel.com). The questions are
// the same `faqItems` array the home accordion, its FAQPage JSON-LD and
// llms-full.txt render from — one source, no filler.

const origin = BASE_URL.replace(/\/+$/, '')
const title = 'Caramel FAQ — free coupon extension questions answered'
const description = `${faqItems.length} answers about the free, open-source Caramel coupon extension: browsers, privacy, affiliate links, how codes are found and applied.`

export const metadata: Metadata = {
    title,
    description,
    alternates: { canonical: `${origin}/faq` },
    openGraph: {
        type: 'website',
        url: `${origin}/faq`,
        title,
        description,
        siteName: 'Caramel',
    },
}

export default function FaqPage() {
    return (
        <main className="flex min-h-screen w-full flex-col items-center px-6 pt-16 dark:bg-darkBg">
            <div className="w-full max-w-4xl">
                <h1 className="sr-only">Caramel frequently asked questions</h1>
                <FaqSection />
            </div>
        </main>
    )
}
