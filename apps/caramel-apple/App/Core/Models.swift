import Foundation

// Wire shapes of the existing grabcaramel.com routes. Each type names the
// producer it mirrors; a server rename fails the decode loudly (APIError)
// instead of rendering blanks.

/// GET /api/coupons, only the slice AlertsEngine reads: the store's visible-code
/// total. (The catalog screens are the web pages now; the full coupon shape is not mirrored.)
struct CouponsPage: Decodable {
    let total: Int
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

enum OAuthProvider: String {
    case apple
    case google
}

/// GET /api/extension/oauth/authorize. `state` is the signed state the
/// provider will hand back on the redirect; the app checks the callback echoes it.
struct OAuthAuthorizeResponse: Decodable {
    let authorizationUrl: String
    let state: String
}

/// POST /api/extension/oauth (200): the minted session.
struct OAuthSessionResult: Decodable {
    let token: String
    let username: String?
    let image: String?
}
