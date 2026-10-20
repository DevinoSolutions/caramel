import Foundation

/// A failed Caramel API call. Carries the request id sent as `x-request-id`
/// so a failure shown in the app can be found in the server logs / Sentry.
struct APIError: LocalizedError {
    let method: String
    let path: String
    let status: Int?
    let requestID: String
    let detail: String

    var isUnauthorized: Bool { status == 401 }

    var errorDescription: String? {
        let outcome = status.map { "HTTP \($0)" } ?? "no response"
        return "\(method) \(path) failed (\(outcome)): \(detail) [request \(requestID)]"
    }
}

/// Minimal typed client over the existing grabcaramel.com JSON API.
/// Nothing here is new server surface: each method is one existing route.
struct CaramelAPI {
    let baseURL: URL
    let session: URLSession

    static let shared = CaramelAPI(baseURL: AppConfig.apiBaseURL, session: .shared)

    private struct ErrorBody: Decodable {
        let error: String?
    }

    /// Sends one request and returns the body of a 2xx response. 204 returns empty data.
    func send(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: Data? = nil,
        bearer: String? = nil
    ) async throws -> (data: Data, status: Int) {
        let requestID = UUID().uuidString
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError(method: method, path: path, status: nil, requestID: requestID, detail: "Base URL is not a valid URL.")
        }
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else {
            throw APIError(method: method, path: path, status: nil, requestID: requestID, detail: "Could not build the request URL.")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(requestID, forHTTPHeaderField: "x-request-id")
        if let bearer = bearer {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        if let body = body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError(method: method, path: path, status: nil, requestID: requestID, detail: error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError(method: method, path: path, status: nil, requestID: requestID, detail: "Response was not HTTP.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let serverMessage = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw APIError(
                method: method,
                path: path,
                status: http.statusCode,
                requestID: requestID,
                detail: serverMessage ?? "unexpected status"
            )
        }
        return (data, http.statusCode)
    }

    func get<T: Decodable>(
        _ path: String,
        query: [URLQueryItem] = [],
        bearer: String? = nil,
        as type: T.Type = T.self
    ) async throws -> T {
        let (data, _) = try await send("GET", path, query: query, bearer: bearer)
        return try decode(type, from: data, method: "GET", path: path)
    }

    func decode<T: Decodable>(_ type: T.Type, from data: Data, method: String, path: String) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw APIError(
                method: method,
                path: path,
                status: nil,
                requestID: "n/a",
                detail: "Response did not match the expected shape: \(error)"
            )
        }
    }
}

// MARK: - Public catalog routes

extension CaramelAPI {
    /// GET /api/coupons/recently-worked
    func recentlyWorked() async throws -> [RecentlyWorkedCoupon] {
        let response: RecentlyWorkedResponse = try await get("/api/coupons/recently-worked")
        return response.coupons
    }

    /// GET /api/sites/top-sites
    func topStores() async throws -> [String] {
        let response: SitesResponse = try await get("/api/sites/top-sites")
        return response.sites.compactMap { $0 }
    }

    /// GET /api/coupons/stores?q=&limit= (empty `query` browses).
    func storeOptions(query: String, limit: Int = 30) async throws -> [String] {
        let response: SitesResponse = try await get(
            "/api/coupons/stores",
            query: [URLQueryItem(name: "q", value: query), URLQueryItem(name: "limit", value: String(limit))]
        )
        return response.sites.compactMap { $0 }
    }

    /// GET /api/coupons?site=&page=&limit=
    func coupons(site: String, page: Int = 1, limit: Int = 50) async throws -> CouponsPage {
        try await get(
            "/api/coupons",
            query: [
                URLQueryItem(name: "site", value: site),
                URLQueryItem(name: "page", value: String(page)),
                URLQueryItem(name: "limit", value: String(limit)),
            ]
        )
    }
}

// MARK: - Account routes (bearer)

extension CaramelAPI {
    /// GET /api/extension/me
    func me(bearer: String) async throws -> MeResponse {
        try await get("/api/extension/me", bearer: bearer)
    }

    /// GET /api/account/overview
    func overview(bearer: String) async throws -> OverviewResponse {
        try await get("/api/account/overview", bearer: bearer)
    }

    /// GET /api/account/favorites
    func favorites(bearer: String) async throws -> [String] {
        let response: FavoritesResponse = try await get("/api/account/favorites", bearer: bearer)
        return response.favorites.map(\.store)
    }

    /// PUT or DELETE /api/account/favorites/:store. Returns the store key the
    /// server actually wrote (it normalizes to the registrable domain).
    func setFavorite(_ store: String, favorited: Bool, bearer: String) async throws -> String {
        let encoded = store.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? store
        let path = "/api/account/favorites/\(encoded)"
        let (data, _) = try await send(favorited ? "PUT" : "DELETE", path, bearer: bearer)
        return try decode(FavoriteWriteResponse.self, from: data, method: favorited ? "PUT" : "DELETE", path: path).store
    }

    /// GET /api/account/export (the JSON download).
    func exportData(bearer: String) async throws -> Data {
        let (data, _) = try await send("GET", "/api/account/export", bearer: bearer)
        return data
    }

    /// POST /api/account/data/delete. Removes synced savings, followed stores
    /// and reports; it does NOT delete the account (see AccountView).
    func deleteSyncedData(bearer: String) async throws {
        let body = try JSONEncoder().encode(["confirm": "DELETE"])
        _ = try await send("POST", "/api/account/data/delete", body: body, bearer: bearer)
    }
}

// MARK: - Sign-in routes (the existing extension OAuth flow, Safari nonce variant)

extension CaramelAPI {
    /// GET /api/extension/oauth/authorize. The redirect target is the web
    /// app's own /redirect hop (the only destination the nonce flow accepts);
    /// the exchange then happens server-side and the app collects the result
    /// from /poll.
    func oauthAuthorize(provider: OAuthProvider, nonce: String) async throws -> OAuthAuthorizeResponse {
        try await get(
            "/api/extension/oauth/authorize",
            query: [
                URLQueryItem(name: "provider", value: provider.rawValue),
                URLQueryItem(name: "redirect_uri", value: baseURL.appendingPathComponent("api/extension/oauth/redirect").absoluteString),
                URLQueryItem(name: "nonce", value: nonce),
            ]
        )
    }

    /// GET /api/extension/oauth/poll. nil while the sign-in is still pending (204).
    func oauthPoll(nonce: String) async throws -> OAuthPollResult? {
        let (data, status) = try await send("GET", "/api/extension/oauth/poll", query: [URLQueryItem(name: "nonce", value: nonce)])
        if status == 204 { return nil }
        return try decode(OAuthPollResult.self, from: data, method: "GET", path: "/api/extension/oauth/poll")
    }
}
