import SearchSection from "@/components/supported-site/search-section";

export const metadata = { title: "Supported Sites | Caramel" };

export default function SupportedSitesPage() {
    return (
        <main className="min-h-screen pt-32 px-6 flex flex-col items-center">
            <SearchSection />
        </main>
    );
}
