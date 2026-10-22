import SwiftUI

/// The Deals tab: codes that recently worked for shoppers, and the top stores.
struct DealsView: View {
    @EnvironmentObject private var favorites: FavoritesStore

    @State private var worked: LoadState<[RecentlyWorkedCoupon]> = .idle
    @State private var topStores: LoadState<[String]> = .idle

    var body: some View {
        NavigationStack {
            List {
                Section("Codes that just worked") {
                    switch worked {
                    case .idle, .loading:
                        ProgressView()
                    case .failed(let message):
                        ErrorBanner(message: message) { Task { await loadWorked() } }
                    case .loaded(let coupons) where coupons.isEmpty:
                        Text("No codes have been confirmed in the last day. Check back soon.")
                            .foregroundStyle(.secondary)
                    case .loaded(let coupons):
                        ForEach(coupons) { coupon in
                            NavigationLink(value: coupon.storeDomain) {
                                WorkedRow(coupon: coupon)
                            }
                        }
                    }
                }
                Section("Top stores") {
                    switch topStores {
                    case .idle, .loading:
                        ProgressView()
                    case .failed(let message):
                        ErrorBanner(message: message) { Task { await loadTopStores() } }
                    case .loaded(let stores):
                        ForEach(stores, id: \.self) { store in
                            NavigationLink(value: store) {
                                StoreRow(domain: store, isSaved: favorites.contains(store))
                            }
                        }
                    }
                }
            }
            .navigationTitle("Deals")
            .navigationDestination(for: String.self) { StoreDetailView(domain: $0) }
            .task { await loadAll() }
            .refreshable { await loadAll() }
        }
    }

    private func loadAll() async {
        async let a: Void = loadWorked()
        async let b: Void = loadTopStores()
        _ = await (a, b)
    }

    private func loadWorked() async {
        worked = .loading
        do {
            worked = .loaded(try await CaramelAPI.shared.recentlyWorked())
        } catch is CancellationError {
            worked = .idle
        } catch {
            worked = .failed(error.localizedDescription)
        }
    }

    private func loadTopStores() async {
        topStores = .loading
        do {
            topStores = .loaded(try await CaramelAPI.shared.topStores())
        } catch is CancellationError {
            topStores = .idle
        } catch {
            topStores = .failed(error.localizedDescription)
        }
    }
}

private struct WorkedRow: View {
    let coupon: RecentlyWorkedCoupon

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(coupon.storeDomain).font(.headline)
            Text(coupon.title).font(.subheadline).lineLimit(2)
            HStack(spacing: 8) {
                Text(coupon.code)
                    .font(.system(.footnote, design: .monospaced).bold())
                if let label = coupon.discountLabel {
                    Text(label).font(.footnote).foregroundStyle(Color.orange)
                }
                if let when = Timestamps.relative(coupon.lastWorkedAt) {
                    Text("worked \(when)").font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
    }
}
