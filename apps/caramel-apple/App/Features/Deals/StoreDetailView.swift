import SwiftUI
import UIKit

/// One store's codes, with copy-code and a save (heart) button.
struct StoreDetailView: View {
    let domain: String

    @EnvironmentObject private var favorites: FavoritesStore

    @State private var state: LoadState<CouponsPage> = .idle
    @State private var copiedID: String?

    var body: some View {
        List {
            switch state {
            case .idle, .loading:
                ProgressView()
            case .failed(let message):
                ErrorBanner(message: message) { Task { await load() } }
            case .loaded(let page) where page.coupons.isEmpty:
                Text("No codes for \(domain) right now.")
                    .foregroundStyle(.secondary)
            case .loaded(let page):
                Section("\(page.total) \(page.total == 1 ? "code" : "codes")") {
                    ForEach(page.coupons) { coupon in
                        CouponRow(coupon: coupon, isCopied: copiedID == coupon.id) { copy(coupon) }
                    }
                }
                if page.hasMore {
                    Text("Showing the first \(page.coupons.count). Open grabcaramel.com for the full list.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(domain)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    Task { await favorites.toggle(domain) }
                } label: {
                    Image(systemName: favorites.contains(domain) ? "heart.fill" : "heart")
                }
                .accessibilityLabel(favorites.contains(domain) ? "Remove from saved stores" : "Save store")
            }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        state = .loading
        do {
            let page = try await CaramelAPI.shared.coupons(site: domain)
            state = .loaded(page)
            // Looking at the codes clears the store's "new" marker (and sets the
            // baseline for a store saved straight from here).
            AlertsEngine.markSeen(store: domain, total: page.total)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func copy(_ coupon: Coupon) {
        UIPasteboard.general.string = coupon.code
        copiedID = coupon.id
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if copiedID == coupon.id { copiedID = nil }
        }
    }
}

private struct CouponRow: View {
    let coupon: Coupon
    let isCopied: Bool
    let onCopy: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(coupon.title).font(.headline).lineLimit(2)
                Spacer()
                if let label = coupon.discountLabel {
                    Text(label).font(.subheadline.bold()).foregroundStyle(Color.orange)
                }
            }
            if !coupon.description.isEmpty {
                Text(coupon.description).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
            }
            HStack {
                Text(coupon.code)
                    .font(.system(.body, design: .monospaced).bold())
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Color.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
                Spacer()
                Button(action: onCopy) {
                    Label(isCopied ? "Copied" : "Copy", systemImage: isCopied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.bordered)
            }
            HStack(spacing: 8) {
                if let worked = coupon.lastWorkedAt, let when = Timestamps.relative(worked) {
                    Text("Worked \(when)")
                }
                if coupon.keepsFailing == true {
                    Text("Often fails")
                }
                if coupon.newCustomersOnly == true {
                    Text("New customers only")
                }
                if coupon.expired {
                    Text("Expired")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}
