import Foundation

// Wire shapes of the existing grabcaramel.com routes. Each type names the
// producer it mirrors; a server rename fails the decode loudly (APIError)
// instead of rendering blanks.

/// lib/recentlyWorkedCoupons.ts
struct RecentlyWorkedResponse: Decodable {
    let coupons: [RecentlyWorkedCoupon]
}

struct RecentlyWorkedCoupon: Decodable, Identifiable {
    let id: String
    let code: String
    let title: String
    let storeDomain: String
    let discountType: String?
    let discountAmount: Double?
    let lastWorkedAt: String
}

/// sites/top-sites and coupons/stores. `top-sites` can emit a null site.
struct SitesResponse: Decodable {
    let sites: [String?]
}

/// GET /api/coupons (CouponListRow + the coupon_signals overlay).
struct CouponsPage: Decodable {
    let coupons: [Coupon]
    let page: Int
    let limit: Int
    let total: Int
    let hasMore: Bool
}

struct Coupon: Decodable, Identifiable {
    let id: String
    let code: String
    let title: String
    let description: String
    let discountType: String?
    let discountAmount: Double?
    let expiry: String?
    let expired: Bool
    let verificationMessage: String?
    let newCustomersOnly: Bool?
    let lastWorkedAt: String?
    let keepsFailing: Bool?

    enum CodingKeys: String, CodingKey {
        case id, code, title, description, expiry, expired
        case verificationMessage, newCustomersOnly, lastWorkedAt, keepsFailing
        case discountType = "discount_type"
        case discountAmount = "discount_amount"
    }
}

/// GET /api/extension/me
struct MeResponse: Decodable {
    let username: String?
    let image: String?
}

/// GET /api/account/favorites
struct FavoritesResponse: Decodable {
    struct Entry: Decodable {
        let store: String
        let createdAt: String
    }
    let favorites: [Entry]
}

/// PUT/DELETE /api/account/favorites/:store
struct FavoriteWriteResponse: Decodable {
    let store: String
    let favorited: Bool
}

/// GET /api/account/overview (lib/profile/types.ts ProfileOverview, the slice the app shows).
struct OverviewResponse: Decodable {
    struct SavingsTotal: Decodable {
        let currency: String
        let minorUnits: Int
    }
    struct Savings: Decodable {
        let syncEnabled: Bool
        let eventCount: Int
        let storeCount: Int
        let totals: [SavingsTotal]
    }
    let memberSince: String?
    let savings: Savings
}

enum OAuthProvider: String {
    case apple
    case google
}

/// GET /api/extension/oauth/authorize
struct OAuthAuthorizeResponse: Decodable {
    let authorizationUrl: String
}

/// GET /api/extension/oauth/poll (200)
struct OAuthPollResult: Decodable {
    let token: String
    let username: String?
    let image: String?
}

// MARK: - Presentation helpers

extension Coupon {
    var discountLabel: String? { DiscountFormat.label(type: discountType, amount: discountAmount) }
}

extension RecentlyWorkedCoupon {
    var discountLabel: String? { DiscountFormat.label(type: discountType, amount: discountAmount) }
}

enum DiscountFormat {
    /// coupon-card.tsx's rule: PERCENTAGE renders "N%", every other type "$N".
    static func label(type: String?, amount: Double?) -> String? {
        guard let amount = amount, amount > 0 else { return nil }
        let number = amount.truncatingRemainder(dividingBy: 1) == 0
            ? String(Int(amount))
            : String(format: "%.2f", amount)
        return type == "PERCENTAGE" ? "\(number)% off" : "$\(number) off"
    }

    static func money(minorUnits: Int, currency: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency
        return formatter.string(from: NSNumber(value: Double(minorUnits) / 100)) ?? "\(minorUnits) \(currency)"
    }
}

enum Timestamps {
    private static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()

    /// The server emits JS `toISOString()` (fractional seconds); a plain
    /// second-resolution timestamp is also valid ISO-8601.
    static func parse(_ iso: String) -> Date? {
        withFraction.date(from: iso) ?? plain.date(from: iso)
    }

    static func relative(_ iso: String) -> String? {
        guard let date = parse(iso) else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
