import Image from 'next/image'
import Link from 'next/link'
import CouponsClient from './CouponsClient'

export default async function CouponsPage() {

    return (
        <main className="mx-auto w-full max-w-[min(75rem,93svw)] px-4 pb-24 pt-8">
            <div className="mb-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <Image src="/caramel.svg" width={28} height={28} alt="Caramel" />
                    <h1 className="text-caramel text-lg font-semibold">Caramel Coupons</h1>
                </div>
                <Link
                    href="/supported-sites"
                    className="bg-caramel hover:bg-[#ff7a45] text-white rounded-full px-4 py-2 text-[11px] font-medium"
                >
                    Supported Sites
                </Link>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
                <section className="space-y-3">
                    <CouponsClient />
                </section>

                {/* Sidebar */}
                <aside className="space-y-3">
                    <div className="rounded-xl border border-orange-100 bg-white p-4 shadow-sm">
                        <h4 className="mb-3 text-sm font-semibold text-gray-900">Caramel</h4>
                        <p className="text-[11px] text-gray-600">
                            The open-source and privacy-first AutoCoupon extension that applies the best
                            coupons at checkout — without selling your data.
                        </p>
                        <ul className="mt-3 space-y-2 text-[11px] text-gray-700">
                            <li>
                                <span className="text-caramel mr-1">15</span> Sites
                            </li>
                            <li>
                                <span className="text-caramel mr-1">3</span> Deals
                            </li>
                            <li>
                                <span className="text-caramel mr-1">10</span> Expired Coupons
                            </li>
                        </ul>
                    </div>

                    <div className="rounded-xl border border-orange-100 bg-white p-4 shadow-sm">
                        <h4 className="mb-2 text-sm font-semibold text-gray-900">Related Stores</h4>
                        <div className="grid grid-cols-3 gap-3">
                            {['/walmart.png', '/netflix.png', '/walmart.png', '/rayban.png'].map(
                                (src, i) => (
                                    <div
                                        key={i}
                                        className="flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50 py-3"
                                    >
                                        <Image src={src} alt="brand" width={48} height={20} />
                                    </div>
                                ),
                            )}
                        </div>
                    </div>
                </aside>
            </div>

            <footer className="mt-8 text-center text-[11px] text-gray-500">
                The open-source and privacy-first alternative to Honey. Automatically finds and applies
                the best coupon codes at checkout — without selling your data.
            </footer>
        </main>
    )
}


