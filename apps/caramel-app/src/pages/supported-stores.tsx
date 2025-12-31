import AppHeader from '@/components/AppHeader'
import SearchSection from '@/components/supported-site/search-section'

export default function SupportedSitesPage() {
    return (
        <>
            <AppHeader
                ogTitle="Caramel | Supported Stores"
                ogDescription="Explore the stores supported by Caramel and start saving with our coupon extension."
                ogUrl="https://grabcaramel.com/supported-sites"
            />
            <main className="flex min-h-screen flex-col items-center px-6 pt-32">
                <SearchSection />
            </main>
        </>
    )
}
