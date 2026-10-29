import Foundation

/// The pages the native shell frames. Every URL is built through AppLinkGuard,
/// and CaramelTests pins that each one passes it.
enum ShellDestination: CaseIterable {
    case deals
    case stores
    case saved
    case profile

    var path: String {
        switch self {
        case .deals: return "/coupons"
        case .stores: return "/coupons/stores"
        case .saved: return "/profile#favorites"
        case .profile: return "/profile"
        }
    }

    var url: URL {
        guard let url = AppLinkGuard.allowedURL(AppLinkGuard.origin + path) else {
            preconditionFailure("ShellDestination \(self) (\(path)) is refused by AppLinkGuard.")
        }
        return url
    }

    /// /coupons/<domain>, for App Store screenshot capture. nil unless `domain`
    /// is a plain hostname, so a launch argument cannot smuggle in a path.
    static func storePage(domain: String) -> URL? {
        guard isPlainHostname(domain) else { return nil }
        return AppLinkGuard.allowedURL("\(AppLinkGuard.origin)/coupons/\(domain)")
    }
}

extension ShellDestination {
    static func isPlainHostname(_ candidate: String) -> Bool {
        candidate.range(of: "^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", options: .regularExpression) != nil
    }
}

/// The user-agent contract with the web team (GetItDone T-7853): the shell
/// appends `CaramelApp/<CFBundleShortVersionString> (ios)` to WebKit's own user
/// agent through `WKWebViewConfiguration.applicationNameForUserAgent`, then (T-10055) a
/// SEPARATE `CaramelBuild/<CFBundleVersion>` token so analytics can tell which build
/// misbehaved. The build is its own token so the web app's CaramelApp matcher
/// (detectSurface.ts, layout.tsx) keeps matching on its own.
enum ShellUserAgent {
    /// TODO(T-4905): "macos" once a macOS target exists (project.yml is iOS only).
    static let platform = "ios"

    static func applicationName(version: String, build: String) -> String {
        "CaramelApp/\(version) (\(platform)) CaramelBuild/\(build)"
    }
}

// The two helpers below live in this file (not their own) so the generated Xcode
// project does not change: both the app and CaramelTests already compile it.


/// The pure parts of the alerts bookkeeping (AlertsEngine owns the storage and
/// the network).
enum AlertsLogic {
    enum Outcome: Equatable {
        /// The store has no baseline yet, or the shopper opened its web page since the
        /// last check: record `total` as seen and report nothing.
        case markSeen(total: Int)
        /// More codes than the shopper last looked at.
        case hit(newCodes: Int)
        /// Codes expired: lower the baseline so the next new one is counted.
        case lowerBaseline(total: Int)
        case nothingNew
    }

    /// `seen` is the total the shopper last looked at (nil: never). `visited` is
    /// true when the store's /coupons/<store> page was opened in the web shell
    /// since the last check, which counts as looking at its codes.
    static func outcome(seen: Int?, total: Int, visited: Bool) -> Outcome {
        guard let seen = seen, !visited else { return .markSeen(total: total) }
        if total > seen { return .hit(newCodes: total - seen) }
        if total < seen { return .lowerBaseline(total: total) }
        return .nothingNew
    }
}

/// Reads the store out of a Caramel web path.
enum StorePath {
    /// `/coupons/<store>` -> the lowercased store domain. nil for `/coupons`,
    /// `/coupons/stores` (the A-Z index), the index's `/coupons/stores/<letter>`
    /// pages and anything that is not a plain hostname.
    static func store(fromSegments segments: [String]) -> String? {
        guard segments.count == 2, segments[0] == "coupons" else { return nil }
        let candidate = segments[1].lowercased()
        guard candidate != "stores", ShellDestination.isPlainHostname(candidate) else { return nil }
        return candidate
    }
}

// MARK: - Native-to-web session handoff (T-7852)
//
// Everything below is pure Foundation (no SwiftUI, no WebKit, no Keychain) so the
// CaramelTests bundle, which compiles this file, can exercise it. It lives in this
// file (not its own) so the generated Xcode project does not change.

/// The contract with the web app's handoff routes (apps/caramel-app/src/app/api/app/web-session/,
/// T-7852): the native session bearer is traded for a one-time redeem URL, and loading that URL
/// in the web view sets the signed session cookie and redirects to `next`.
enum WebSessionHandoff {
    static let handoffPath = "/api/app/web-session/handoff"
    static let redeemPath = "/api/app/web-session/redeem"
    /// `/login?error=handoff_expired` is where the redeem route sends an expired, used or revoked code.
    static let expiredErrorValue = "handoff_expired"

    /// The server accepts `next` = "/" or a path under these (handoff/route.ts ALLOWED_NEXT_PREFIXES).
    private static let nextSegments: Set<String> = ["coupons", "profile", "welcome"]
    private static let maxNextLength = 512

    /// The percent-encoded path segments of a Caramel-origin URL, nil for anything AppLinkGuard refuses.
    private static func encodedSegments(of url: URL) -> (components: URLComponents, segments: [String])? {
        guard AppLinkGuard.isAllowed(url.absoluteString),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }
        let segments = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        return (components, segments)
    }

    /// True for a page the server's `next` allowlist covers: the home page, /coupons*, /profile*, /welcome*.
    /// A redeem that ends on one of these has set the session cookie.
    static func isSessionPage(_ url: URL) -> Bool {
        guard let parsed = encodedSegments(of: url) else { return false }
        guard let first = parsed.segments.first else { return true }
        return nextSegments.contains(first)
    }

    /// `target` as the handoff `next` value, nil when the server would refuse it: not on the
    /// allowlist, longer than 512 characters, or carrying a percent-encoded CR/LF. The query and
    /// fragment ride along (`/profile#favorites`); the home page is sent as a bare "/" because
    /// the server only accepts "/" itself, not "/?x=1".
    static func exactNextPath(for target: URL) -> String? {
        guard isSessionPage(target), let parsed = encodedSegments(of: target) else { return nil }
        guard !parsed.segments.isEmpty else { return "/" }
        var next = "/" + parsed.segments.joined(separator: "/")
        if let query = parsed.components.percentEncodedQuery { next += "?" + query }
        if let fragment = parsed.components.percentEncodedFragment { next += "#" + fragment }
        if next.count > maxNextLength || next.range(of: "%0[dDaA]", options: .regularExpression) != nil { return nil }
        return next
    }

    /// The `next` to send for `target`: the page itself when the server accepts it, else the home page.
    static func nextPath(for target: URL) -> String {
        exactNextPath(for: target) ?? "/"
    }

    /// True for the redeem route on the Caramel origin (any code).
    static func isRedeemURL(_ url: URL) -> Bool {
        guard AppLinkGuard.isAllowed(url.absoluteString),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return false }
        return components.path == redeemPath
    }

    /// True for the redirect the redeem route answers an expired, used or revoked code with.
    static func isExpiredRedirect(_ url: URL) -> Bool {
        guard let parsed = encodedSegments(of: url), parsed.segments == ["login"] else { return false }
        return parsed.components.queryItems?.contains { $0.name == "error" && $0.value == expiredErrorValue } ?? false
    }

    /// The server mints `randomBytes(32)` as base64url: exactly 43 characters of [A-Za-z0-9_-].
    static let issuedCodeLength = 43

    static func isIssuedCode(_ code: String) -> Bool {
        code.utf8.count == issuedCodeLength && code.utf8.allSatisfy { byte in
            (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte)
                || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte)
                || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
                || byte == UInt8(ascii: "-") || byte == UInt8(ascii: "_")
        }
    }

    /// True when `cookies` hold better-auth's session cookie for grabcaramel.com (the redeem
    /// sets `__Secure-better-auth.session_token`, HttpOnly, on the exact host).
    static func hasSessionCookie(_ cookies: [HTTPCookie]) -> Bool {
        cookies.contains { cookie in
            cookie.name.hasSuffix("better-auth.session_token")
                && cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) == "grabcaramel.com"
                && !cookie.value.isEmpty
        }
    }

    /// The redeem URL from a handoff response, only when it is safe to load: it passes the
    /// AppLinkGuard string gate and decision, sits on exactly the redeem path, carries exactly
    /// one query item, `code`, shaped like the server's codes, and no fragment. Anything else
    /// is nil, so a hostile or drifted response never reaches the web view.
    static func vettedRedeemURL(_ candidate: String) -> URL? {
        guard let url = AppLinkGuard.allowedURL(candidate),
              AppLinkGuard.decision(for: url, isMainFrame: true) == .loadInShell(url),
              isRedeemURL(url),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.fragment == nil,
              let items = components.queryItems, items.count == 1, items[0].name == "code",
              let code = items[0].value, isIssuedCode(code)
        else { return nil }
        return url
    }
}

/// A failed handoff request. The cases are the shell's decisions: a dead native session
/// ends the session, anything transient is a retry, the rest is a contract problem to show.
/// The descriptions never carry the bearer, the code or the redeem URL.
enum WebSessionHandoffError: LocalizedError, Equatable {
    /// 401: the native session is dead (expired or revoked).
    case unauthorized
    /// No response, a timeout, 429 or 5xx: worth a retry.
    case unavailable(detail: String)
    /// Another 4xx: the server answered and will answer the same again.
    case rejected(status: Int, requestID: String)
    /// A 2xx whose body is not `{ "url": ... }`.
    case malformedResponse(requestID: String)
    /// The returned url is not the redeem route on the Caramel origin; it is never loaded.
    case untrustedRedeemURL(requestID: String)

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Your Caramel session expired. Please sign in again."
        case .unavailable(let detail):
            return "Could not open your Caramel account page (\(detail)). Check your connection and try again."
        case .rejected(let status, let requestID):
            return "Caramel refused to open your account page (HTTP \(status)) [request \(requestID)]."
        case .malformedResponse(let requestID):
            return "Caramel answered with something this app does not understand [request \(requestID)]."
        case .untrustedRedeemURL(let requestID):
            return "Caramel answered with an address this app will not open [request \(requestID)]."
        }
    }
}

/// POST /api/app/web-session/handoff with the native bearer. Bearer-only on the server (cookies
/// are ignored, so none are sent), no retries here: the caller decides what a failure means.
struct WebSessionHandoffClient {
    let session: URLSession
    let timeout: TimeInterval

    init(session: URLSession = .shared, timeout: TimeInterval = 15) {
        self.session = session
        self.timeout = timeout
    }

    private struct RequestBody: Encodable {
        let next: String
    }

    private struct ResponseBody: Decodable {
        let url: String
    }

    /// The vetted redeem URL for `next`. Throws WebSessionHandoffError, or CancellationError
    /// when the calling task was cancelled.
    func redeemURL(next: String, bearer: String) async throws -> URL {
        guard let endpoint = AppLinkGuard.allowedURL(AppLinkGuard.origin + WebSessionHandoff.handoffPath) else {
            preconditionFailure("The handoff endpoint is refused by AppLinkGuard.")
        }
        let requestID = UUID().uuidString
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(requestID, forHTTPHeaderField: "x-request-id")
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        do {
            request.httpBody = try JSONEncoder().encode(RequestBody(next: next))
        } catch {
            throw WebSessionHandoffError.malformedResponse(requestID: requestID)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request, delegate: NoRedirectTaskDelegate())
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch let error as URLError {
            throw WebSessionHandoffError.unavailable(detail: "network error \(error.code.rawValue), request \(requestID)")
        } catch {
            throw WebSessionHandoffError.unavailable(detail: "request \(requestID) failed")
        }
        guard let http = response as? HTTPURLResponse else {
            throw WebSessionHandoffError.unavailable(detail: "no HTTP response, request \(requestID)")
        }
        switch http.statusCode {
        case 200..<300:
            break
        case 401:
            throw WebSessionHandoffError.unauthorized
        case 429, 500...:
            throw WebSessionHandoffError.unavailable(detail: "HTTP \(http.statusCode), request \(requestID)")
        default:
            throw WebSessionHandoffError.rejected(status: http.statusCode, requestID: requestID)
        }
        guard let body = try? JSONDecoder().decode(ResponseBody.self, from: data) else {
            throw WebSessionHandoffError.malformedResponse(requestID: requestID)
        }
        guard let url = WebSessionHandoff.vettedRedeemURL(body.url) else {
            throw WebSessionHandoffError.untrustedRedeemURL(requestID: requestID)
        }
        return url
    }
}

/// Whether the web views hold a signed-in web session, and what to do next when the handoff
/// that creates it succeeds or fails. Pure: ShellRouter feeds it events and does what the
/// returned action says. The rules it holds in one place:
///  - one handoff at a time (`begin` refuses while one is in flight or the session is active);
///  - active only after a redeem has landed on an allowlisted page;
///  - at most ONE fresh handoff after the server says `handoff_expired`, then native sign-in;
///  - a 401 ends the native session instead of retrying;
///  - `reset` (sign-out, account deletion, web state wipe) always drops back to inactive.
/// `generation` changes on every start, retry and reset, so a late result of an abandoned
/// handoff can be recognised and dropped.
struct WebSessionMachine: Equatable {
    enum Phase: Equatable {
        case inactive
        /// `freshHandoffUsed`: the one extra handoff after `handoff_expired` has been spent.
        case handingOff(freshHandoffUsed: Bool)
        case active
        /// Waiting for the shopper to retry; the message is shown on the page.
        case failed(String)
    }

    enum Action: Equatable {
        case none
        /// Request another handoff for the same page (the single fresh retry).
        case requestHandoff
        /// The native session is dead: clear it and offer native sign-in.
        case endNativeSession
        /// Offer native sign-in; the web session could not be established.
        case showNativeSignIn
        case showError(String)
    }

    private(set) var phase: Phase = .inactive
    private(set) var generation = 0

    var isActive: Bool { phase == .active }

    /// Starts a handoff. False when one is already in flight or the web session is already active.
    mutating func begin() -> Bool {
        switch phase {
        case .inactive, .failed:
            phase = .handingOff(freshHandoffUsed: false)
            generation += 1
            return true
        case .handingOff, .active:
            return false
        }
    }

    /// The handoff POST failed.
    mutating func handoffRequestFailed(_ error: WebSessionHandoffError) -> Action {
        guard case .handingOff = phase else { return .none }
        if error == .unauthorized {
            phase = .inactive
            return .endNativeSession
        }
        let message = error.errorDescription ?? "Could not open your account page."
        phase = .failed(message)
        return .showError(message)
    }

    /// The redeem navigation finished on an allowlisted page: the session cookie is set.
    /// False when no handoff was in flight (a stale event).
    mutating func redeemLanded() -> Bool {
        guard case .handingOff = phase else { return false }
        phase = .active
        return true
    }

    /// The redeem landed on `/login?error=handoff_expired`.
    mutating func redeemExpired() -> Action {
        guard case .handingOff(let freshHandoffUsed) = phase else { return .none }
        if freshHandoffUsed {
            phase = .inactive
            return .showNativeSignIn
        }
        phase = .handingOff(freshHandoffUsed: true)
        generation += 1
        return .requestHandoff
    }

    /// The redeem navigation itself failed (network, a terminated web process, an unexpected page).
    mutating func redeemNavigationFailed(_ message: String) -> Action {
        guard case .handingOff = phase else { return .none }
        phase = .failed(message)
        return .showError(message)
    }

    /// Sign-out, account deletion or a web state wipe: no web session, nothing in flight.
    mutating func reset() {
        phase = .inactive
        generation += 1
    }
}

/// When the web views' copy of the web session must be wiped, decided from the native session
/// bearer's identity (mirrors Android's WebSessionLifecycle). The tokens are only compared,
/// never logged.
enum WebSessionLifecycle {
    /// True when a token that was there is gone (A to nil) or replaced by another one (A to B,
    /// which skips nil when a new sign-in lands while the old token is still set). False at the
    /// first sign-in (nil to A) and when the token is unchanged.
    static func shouldWipeWebSession(previous: String?, current: String?) -> Bool {
        previous != nil && previous != current
    }

    /// After a wipe, a token that is still present (A to B) belongs to a new sign-in that needs
    /// its own handoff.
    static func shouldRelinkAfterWipe(current: String?) -> Bool {
        current != nil
    }
}

/// Declines every redirect, so the handoff POST (which carries the bearer) never follows one
/// anywhere: the 3xx itself is returned to the caller. Android sets instanceFollowRedirects=false.
final class NoRedirectTaskDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

extension WebSessionHandoff {
    /// True for the pages that bounce a signed-out visitor to /login: the account pages (/profile*).
    /// Stepping back into one without a web session loops (CARAMEL-2Y).
    static func pageNeedsSession(_ url: URL) -> Bool {
        guard let parsed = encodedSegments(of: url) else { return false }
        return parsed.segments.first == "profile"
    }
}

/// Stops a /login bounce from becoming a loop: the shell steps back after a bounce only if the
/// page it would step back into has not already bounced, and not within `window` of the last
/// bounce. Pure; WebShellModel owns one per web view.
struct BounceGuard: Equatable {
    /// A second bounce inside this many seconds is a loop, not a shopper.
    static let window: TimeInterval = 2

    private var lastBounceAt: Date?
    private var lastBackURL: URL?

    /// Records this bounce and says whether stepping back to `backURL` is allowed. False when
    /// there is nothing to step back to, when the previous bounce was under `window` ago, and
    /// when the previous bounce stepped back to the same URL.
    mutating func allowsStepBack(at now: Date, backURL: URL?) -> Bool {
        let previousAt = lastBounceAt
        let previousURL = lastBackURL
        lastBounceAt = now
        lastBackURL = backURL
        guard let backURL = backURL else { return false }
        if let previousAt = previousAt, now.timeIntervalSince(previousAt) < Self.window { return false }
        if previousURL == backURL { return false }
        return true
    }
}

/// The hard cap on sign-in requests that survives `WebShellModel.resetToHome` (T-10055).
/// BounceGuard is recreated on every reset, so a lap that ends in a session change (signed-out
/// /profile, /login, native sheet, session change, reset, reload) handed it a clean slate each
/// time. This one lives inside SignInRecovery (owned by the WebShellModel, never recreated) and counts sign-in requests per tab over a
/// sliding `window`; past `maxRequests` it reports "tripped" and the shell stops asking.
/// 4 because a shopper needs at most one or two (tap a tab, cancel the sheet, tap again) and
/// every real request waits on a human through an OAuth sheet, so a fifth within a minute is a
/// machine; the loop this exists for ran about once a second, so it trips within ~5 s instead of
/// running for days (19.6k pageviews 10-24..10-26). Pure; WebShellModel feeds it the clock.
struct SignInBounceLimiter: Equatable {
    static let window: TimeInterval = 60
    static let maxRequests = 4

    enum Verdict: Equatable {
        case allowed
        /// This request crossed the cap: the one to report.
        case tripped
        /// Over the cap and already reported for this run of requests.
        case stillTripped
    }

    private var requestTimes: [Date] = []

    /// Records one sign-in request at `now`. Requests older than `window` no longer count, so a
    /// shopper who is left alone for a minute starts fresh.
    mutating func record(at now: Date) -> Verdict {
        requestTimes.removeAll { now.timeIntervalSince($0) >= Self.window }
        requestTimes.append(now)
        if requestTimes.count <= Self.maxRequests { return .allowed }
        return requestTimes.count == Self.maxRequests + 1 ? .tripped : .stillTripped
    }

    /// Whether the cap is currently exceeded, without counting a request.
    func isTripped(at now: Date) -> Bool {
        requestTimes.filter { now.timeIntervalSince($0) < Self.window }.count > Self.maxRequests
    }

    /// A shopper tapped "Sign in" or "Try again": that is a person, not a loop.
    mutating func clear() {
        requestTimes.removeAll()
    }
}

/// What the router answers a page load or a recovery step (WebShellModel.webSessionGate and
/// .webSessionRecovery). Three answers because "false" used to mean both "load it yourself" and
/// "the loop cap stopped this", and the second must never load anything.
enum WebSessionGate: Equatable {
    /// Nothing to hand off (not signed in natively, or the web session is active): load the page now.
    case allow
    /// The router took over: it holds the load until the handoff has made a web session.
    case held
    /// The tab's sign-in loop cap forbids it. Load nothing, start nothing; the tab stays on "sign in".
    case blocked
}

/// The one admission gate for every AUTOMATIC sign-in or recovery step of a tab (T-10055):
/// the native sign-in pop-up, stepping the page back, and starting or continuing a web-session
/// handoff/redeem. WebShellModel asks it before each such step and does nothing the answer
/// forbids; ShellRouter asks the model before it starts, queues, replays or refreshes anything for
/// the tab. A shopper's own tap is never gated: `userTapped` clears the cap.
///
/// It owns the SignInBounceLimiter, a `generation` (the token of "recovery work that is still
/// wanted") and `isStopped` (the tab is parked on its "sign in" screen). Work admitted by
/// `.proceed(token:)` may complete only while `isCurrent(token)`: a trip and a reset to home both
/// advance the generation, so a handoff or redeem already in flight when the cap tripped (or when
/// the web view was replaced) is dropped instead of finishing and presenting sign-in again.
/// `isStopped` latches on a stop and stays until the shopper taps (or the web view is replaced), so a
/// late navigation callback or another tab's handoff cannot pull the tab off "sign in".
/// `resetToHome` advances the generation but, on purpose, never touches the limiter: resetting the
/// web view every lap is how the loop outran BounceGuard.
struct SignInRecovery: Equatable {
    enum Decision: Equatable {
        /// Run the automatic step; carry `token` on any work that completes later.
        case proceed(token: Int)
        /// Do nothing automatic: no pop-up, no step back, no handoff. `firstTime` is true for the
        /// one request that tripped the cap (report that one).
        case stop(firstTime: Bool)
    }

    private var limiter = SignInBounceLimiter()
    private var generation = 0
    /// The tab is parked on "sign in" because the cap stopped it; only a tap (or a reset) unparks it.
    private(set) var isStopped = false

    /// A sign-in request from the page or the start of an automatic handoff. Counts toward the cap.
    mutating func automaticRequest(at now: Date) -> Decision {
        switch limiter.record(at: now) {
        case .allowed:
            isStopped = false
            return .proceed(token: generation)
        case .tripped:
            generation += 1
            isStopped = true
            return .stop(firstTime: true)
        case .stillTripped:
            isStopped = true
            return .stop(firstTime: false)
        }
    }

    /// A further automatic step of a recovery that was already admitted (the handoff a bounce
    /// started, the native prompt after a failed handoff). Checks the cap, counts nothing.
    mutating func continueRecovery(at now: Date) -> Decision {
        guard limiter.isTripped(at: now) else { return .proceed(token: generation) }
        isStopped = true
        return .stop(firstTime: false)
    }

    /// Whether the router may queue, replay or refresh a load for this tab on its own (nothing
    /// counted): not parked on "sign in" and the cap not tripped.
    func allowsAutomaticWork(at now: Date) -> Bool {
        !isStopped && !limiter.isTripped(at: now)
    }

    /// False for work admitted before a trip or a reset: it must be dropped, not finished.
    func isCurrent(_ token: Int) -> Bool {
        token == generation
    }

    /// The web view was replaced. Pending recovery work is stale and the tab is no longer parked
    /// (its page state is reset too); the cap keeps counting.
    mutating func resetToHome() {
        generation += 1
        isStopped = false
    }

    /// The shopper tapped "Sign in" or "Try again". Admission is restored. The generation is kept:
    /// work that went stale at the trip stays stale.
    mutating func userTapped() {
        limiter.clear()
        isStopped = false
    }
}

/// Which redeem attempt (T-7852) an event belongs to. Every `openRedeem` begins an attempt with a
/// new id, and each stop, reset, replacement of the web view or later attempt invalidates the
/// earlier ones, so an outcome that arrives late (a cookie read that finishes after a trip, a retry
/// and a new handoff on the same web view) is recognised by its id and dropped instead of settling
/// the NEW handoff. The ids never repeat for the life of the model, resets included. Pure.
struct RedeemAttempts: Equatable {
    private var lastIssued = 0
    private var navigatingID: Int?
    private var readingID: Int?

    /// True from `begin` until the redeem navigation ends: the shell is mid-redeem.
    var isNavigating: Bool { navigatingID != nil }

    /// A new redeem attempt; invalidates any earlier one.
    mutating func begin() -> Int {
        lastIssued += 1
        navigatingID = lastIssued
        readingID = nil
        return lastIssued
    }

    /// The redeem navigation ended without a page (expired, bounced, failed, the web process died):
    /// the id to report once, nil when there is no live attempt.
    mutating func endNavigation() -> Int? {
        let id = navigatingID
        navigatingID = nil
        return id
    }

    /// The redeem navigation finished on a page: the session cookie read starts. nil when stale.
    mutating func startCookieRead() -> Int? {
        guard let id = navigatingID else { return nil }
        navigatingID = nil
        readingID = id
        return id
    }

    /// The cookie read for `id` finished. False when that attempt was invalidated meanwhile.
    mutating func finishCookieRead(_ id: Int) -> Bool {
        guard readingID == id else { return false }
        readingID = nil
        return true
    }

    /// Stop, reset or replacement of the web view: nothing in flight may report any more.
    mutating func invalidate() {
        navigatingID = nil
        readingID = nil
    }
}

/// What a main-frame navigation means while our own redeem is in flight (CARAMEL-2Y follow-up):
/// the redeem chain must end on an allowlisted page, so a sign-in page ends it as a failure
/// instead of leaving the shell spinning on a handoff nobody will complete.
enum RedeemNavigation: Equatable {
    /// Not a redeem-ending navigation: the normal AppLinkGuard decision applies (this includes the landing page).
    case proceed
    /// `/login?error=handoff_expired`: the code was dead; the router may retry once.
    case expired
    /// Any other /login or /signup (cookie or origin drift, the session revoked mid-redeem): the redeem failed.
    case signInBounce

    static func classify(_ url: URL, redeemInFlight: Bool, isMainFrame: Bool = true) -> RedeemNavigation {
        guard redeemInFlight, isMainFrame else { return .proceed }
        if WebSessionHandoff.isExpiredRedirect(url) { return .expired }
        return AppLinkGuard.decision(for: url, isMainFrame: true) == .signIn ? .signInBounce : .proceed
    }
}
