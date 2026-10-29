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

/// How the web-session redeem navigation (T-7852) ended, reported by the shell that loaded it.
enum RedeemOutcome: Equatable {
    /// The redeem 303 landed on an allowlisted page: the session cookie is set.
    case landed
    /// The server redirected to `/login?error=handoff_expired` (expired, used or revoked code).
    case expired
    /// The navigation failed or ended somewhere unexpected; the message is safe to show.
    case failed(String)
}

/// What ShellRouter knows about the web session when a tab asks (WebShellModel.webSessionContext).
enum WebSessionContext: Equatable {
    /// Not signed in natively: there is nothing to hand off.
    case signedOut
    /// The web views already hold the web session.
    case active
    /// A handoff, or the web-data wipe that must finish before one, is in flight: a load waits for it.
    case pending
    /// Signed in natively, no web session and nothing in flight: a handoff has to start.
    case needed

    static func of(isSignedIn: Bool, wipesInFlight: Int, phase: WebSessionMachine.Phase) -> WebSessionContext {
        guard isSignedIn else { return .signedOut }
        if wipesInFlight > 0 { return .pending }
        switch phase {
        case .active: return .active
        case .handingOff: return .pending
        case .inactive, .failed: return .needed
        }
    }
}

/// One step SignInLoopCoordinator tells its tab's adapter (WebShellModel, and through it ShellRouter) to carry out.
enum SignInLoopEffect: Equatable {
    /// Load `url` in the tab's web view.
    case load(URL)
    /// Reload the page the web view shows.
    case reload
    /// Step the web view back one page.
    case stepBack
    /// Stop whatever the web view is loading.
    case stopLoading
    /// Show loading while ShellRouter queues `url` until the handoff in flight ends.
    case holdForWebSession(URL)
    /// Show loading while ShellRouter starts a web-session handoff hosted by this tab, ending on `url`.
    case startHandoff(URL)
    /// Pop the native "Apple or Google?" sign-in prompt.
    case showNativeSignIn
    case showLoading
    case showLoaded
    /// The "Sign in to see this page" screen.
    case showSignInScreen
    case showFailure(String)
    /// Read the web view's cookies for redeem `attempt`, then report `cookieReadFinished`.
    case readSessionCookie(attempt: Int)
    /// Tell ShellRouter how redeem `attempt` ended.
    case settleRedeem(attempt: Int, RedeemOutcome)
    /// The tab just parked on "sign in": report it once, and ShellRouter drops every handoff and held load it has for the tab.
    case parked
    /// Log this fixed message (it never carries a URL) as an error.
    case logError(String)
}

/// What decidePolicyFor does with a navigation before AppLinkGuard sees it.
enum SignInLoopNavigation: Equatable {
    /// AppLinkGuard decides, as for any navigation.
    case guardDecides
    /// Cancel: the tab is parked on "sign in", so no main-frame navigation runs under that screen.
    case cancelWhileParked
    /// Cancel: a redeem URL that is not the one issued for the redeem in flight (or was already used).
    case refuseUnissuedRedeemURL
    /// Cancel: this navigation ends the redeem in flight; then carry out `effects`.
    case endRedeem([SignInLoopEffect])
}

/// Every automatic sign-in decision of ONE tab, in one pure type (T-10055, CARAMEL-2Y): whether a load
/// runs, waits for or starts a web-session handoff; what a page asking for /login gets (native prompt,
/// step back, handoff); which redeem attempt a navigation outcome belongs to; and the loop cap.
/// WebShellModel feeds it events and carries out the returned effects, nothing else.
///
/// The loop cap: more than `maxAutomaticRequests` automatic sign-in requests (a page asking for
/// /login, or a load that has to start a handoff) inside a sliding `window` PARKS the tab. A parked
/// tab shows "sign in" and does nothing on its own: no load, no handoff, no native prompt, no step
/// back, every main-frame navigation cancelled, no late callback replacing the sign-in screen. Only
/// the shopper's tap on Sign in / Try again unparks it, and the tap unparks BEFORE its own load is
/// issued, so that load (and its navigation) is admitted. Time does not unpark it, and neither does
/// `resetToHome` (a session change): resetting the web view every lap is how the loop outran
/// BounceGuard, which is recreated on every reset. 4 because a shopper needs at most one or two
/// (tap a tab, cancel the sheet, tap again) and every real request waits on a person through an OAuth
/// sheet; the loop this exists for ran about once a second for days (19.6k pageviews 10-24..10-26).
///
/// Redeem attempts: the id comes from ShellRouter (unique for the app run) and the attempt is bound
/// to the WKNavigation `load` returned for it (an ObjectIdentifier; WebShellModel keeps that object
/// alive so the identifier cannot be reused). A finish, failure or cookie read of any other navigation
/// or attempt is dropped instead of settling the redeem in flight.
struct SignInLoopCoordinator {
    static let window: TimeInterval = 60
    static let maxAutomaticRequests = 4

    private struct RedeemAttempt {
        let id: Int
        /// The one redeem URL issued for this attempt; it may load once.
        var issuedURL: URL?
        /// ObjectIdentifier of the WKNavigation the redeem load returned.
        var navigation: ObjectIdentifier?
        /// The navigation finished on a landing page and the cookie read is running.
        var readingCookie = false
    }

    /// Parked on "sign in" by the loop cap until the shopper taps.
    private(set) var isParked = false
    private var requestTimes: [Date] = []
    /// Recreated by resetToHome, like the web view it guards.
    private var bounceGuard = BounceGuard()
    private var redeem: RedeemAttempt?

    // MARK: Loads

    /// An ordinary page load (first appearance, an incoming link, window.open, the router's sign-in relink).
    mutating func pageLoadRequested(_ url: URL, webSession: WebSessionContext, at now: Date) -> [SignInLoopEffect] {
        guard !isParked else {
            return [.logError("Did not load a page: this tab is parked on sign-in until the shopper taps."), .showSignInScreen]
        }
        switch webSession {
        case .signedOut, .active:
            return [.load(url)]
        case .pending:
            return [.holdForWebSession(url)]
        case .needed:
            guard admitAutomaticRequest(at: now) else { return park() }
            return [.startHandoff(url)]
        }
    }

    /// ShellRouter's own load once the web session exists (a held load, the host's final page).
    func webSessionLoad(_ url: URL) -> [SignInLoopEffect] {
        guard !isParked else { return [.logError("Dropped a load the web session released: this tab is parked on sign-in.")] }
        return [.load(url)]
    }

    /// Another tab's redeem made the web session: show this tab's page signed in.
    func webSessionEstablishedElsewhere(target: URL, hasStartedLoading: Bool, hasPage: Bool, showsSignInScreen: Bool) -> [SignInLoopEffect] {
        guard hasStartedLoading, !isParked else { return [] }
        return !hasPage || showsSignInScreen ? [.load(target)] : [.reload]
    }

    /// The web session could not be made; a parked tab keeps its sign-in screen.
    func webSessionFailed(_ message: String) -> [SignInLoopEffect] {
        isParked ? [] : [.showFailure(message)]
    }

    // MARK: Sign-in requests

    /// The page asked for /login or /signup (the web app routed itself there, a navigation was
    /// refused as sign-in, or window.open asked for it). The web login page itself is never left on screen.
    ///
    /// Stepping back into a page that bounces signed-out visitors to /login makes it bounce again at
    /// once (CARAMEL-2Y: /profile#favorites to /login in a ~150 ms loop until Safari refused pushState). So:
    ///  - a page that needs a web session (/profile*) is never stepped back into: with a native session a
    ///    handoff runs for it (or waits for the one in flight), without one the tab shows "sign in";
    ///  - any other page is stepped back to only once per back URL and not twice within
    ///    BounceGuard.window, else the tab shows "sign in".
    /// `bouncedFrom` is the page the request came from, `backURL` the back-forward list's back item,
    /// `hasPage` whether the web view shows any page.
    mutating func automaticSignInRequest(
        stepBack: Bool,
        bouncedFrom: URL?,
        backURL: URL?,
        hasPage: Bool,
        webSession: WebSessionContext,
        at now: Date
    ) -> [SignInLoopEffect] {
        guard !isParked else { return [] }
        guard admitAutomaticRequest(at: now) else { return park() }
        if let page = bouncedFrom, WebSessionHandoff.pageNeedsSession(page) {
            switch webSession {
            case .needed: return [.startHandoff(page)]
            case .pending: return [.holdForWebSession(page)]
            case .signedOut, .active: return [.showNativeSignIn, .showSignInScreen]
            }
        }
        guard stepBack else { return hasPage ? [.showNativeSignIn] : [.showNativeSignIn, .showSignInScreen] }
        if bounceGuard.allowsStepBack(at: now, backURL: backURL) { return [.showNativeSignIn, .stepBack] }
        return [.showNativeSignIn, .logError("A page bounced to sign-in again; not stepping back into it."), .showSignInScreen]
    }

    // MARK: The shopper's taps (never capped)

    /// "Sign in" on the sign-in screen: unparks, starts the count over and pops the native prompt.
    mutating func userTappedSignIn() -> [SignInLoopEffect] {
        unpark()
        return [.showNativeSignIn]
    }

    /// "Try again" (or pull to refresh on an empty tab): unparks and starts the count over FIRST, then
    /// loads `url` like any load, so the load and its navigation are admitted.
    mutating func userTappedTryAgain(_ url: URL, webSession: WebSessionContext, at now: Date) -> [SignInLoopEffect] {
        unpark()
        return pageLoadRequested(url, webSession: webSession, at: now)
    }

    // MARK: Lifecycle

    /// ShellRouter stops the tab (a wipe is coming): a redeem in flight may not report any more.
    mutating func stopLoading() -> [SignInLoopEffect] {
        redeem = nil
        return [.stopLoading]
    }

    /// The web view was replaced. Its BounceGuard and redeem go with it; the count and the parked
    /// latch stay, on purpose (see the type's documentation).
    mutating func resetToHome() {
        bounceGuard = BounceGuard()
        redeem = nil
    }

    // MARK: Redeem (T-7852)

    /// ShellRouter's handoff got its redeem URL: begin `attempt`. False when the tab is parked (load nothing).
    mutating func beginRedeem(_ redeemURL: URL, attempt: Int) -> Bool {
        guard !isParked else { return false }
        redeem = RedeemAttempt(id: attempt, issuedURL: redeemURL)
        return true
    }

    /// The redeem load for `attempt` was issued and returned `navigation` (nil when WebKit started none).
    mutating func redeemLoadIssued(attempt: Int, navigation: ObjectIdentifier?) -> [SignInLoopEffect] {
        guard redeem?.id == attempt else { return [.logError("A redeem load was issued for an attempt that is no longer current.")] }
        guard let navigation = navigation else {
            redeem = nil
            return [.logError("WebKit started no navigation for the web-session redeem."), .settleRedeem(attempt: attempt, .failed("Could not open your account page. Please try again."))]
        }
        redeem?.navigation = navigation
        return []
    }

    /// Before AppLinkGuard: the parked tab's cancel, the one-time redeem URL, and the main-frame
    /// navigations that end our redeem (the redeem route answers a dead code with a redirect to /login;
    /// while the redeem is in flight that is the handoff failing, not a page asking to sign in).
    mutating func navigationPolicy(for url: URL, isMainFrame: Bool) -> SignInLoopNavigation {
        if isParked && isMainFrame { return .cancelWhileParked }
        if WebSessionHandoff.isRedeemURL(url) {
            guard let issued = redeem?.issuedURL, issued == url else { return .refuseUnissuedRedeemURL }
            redeem?.issuedURL = nil
        }
        guard let attempt = redeem, !attempt.readingCookie else { return .guardDecides }
        switch RedeemNavigation.classify(url, redeemInFlight: true, isMainFrame: isMainFrame) {
        case .proceed:
            return .guardDecides
        case .expired:
            redeem = nil
            return .endRedeem([.settleRedeem(attempt: attempt.id, .expired)])
        case .signInBounce:
            // Without ending the redeem here the cancel is swallowed as NSURLErrorCancelled and the
            // shell would wait on the handoff forever.
            redeem = nil
            return .endRedeem([.settleRedeem(attempt: attempt.id, .failed("Your account page asked you to sign in again. Please try again."))])
        }
    }

    func navigationStarted() -> [SignInLoopEffect] {
        isParked ? [] : [.showLoading]
    }

    /// `navigation` finished at `url`. The redeem's own navigation worked when it ended on a page the
    /// handoff `next` allowlist covers (the 303 sets the cookie before it redirects); the cookie read
    /// then confirms the signed session cookie is really there.
    mutating func navigationFinished(_ navigation: ObjectIdentifier?, at url: URL?) -> [SignInLoopEffect] {
        guard !isParked else { return [] }
        guard let attempt = redeem, !attempt.readingCookie else { return [.showLoaded] }
        guard let navigation = navigation, navigation == attempt.navigation else {
            return [.logError("Ignored a page that finished loading while a different navigation is the redeem in flight.")]
        }
        guard let url = url, WebSessionHandoff.isSessionPage(url) else {
            redeem = nil
            return [.showLoaded, .logError("The web-session redeem ended on an unexpected page."), .settleRedeem(attempt: attempt.id, .failed("Your account page did not open as expected. Please try again."))]
        }
        redeem?.readingCookie = true
        redeem?.issuedURL = nil
        return [.showLoaded, .readSessionCookie(attempt: attempt.id)]
    }

    /// The cookie read for `attempt` finished.
    mutating func cookieReadFinished(attempt: Int, hasSessionCookie: Bool) -> [SignInLoopEffect] {
        guard let current = redeem, current.id == attempt, current.readingCookie else {
            return [.logError("Dropped the cookie read of a redeem attempt that is no longer current.")]
        }
        redeem = nil
        guard hasSessionCookie else {
            return [.logError("The web-session redeem landed without a session cookie."), .settleRedeem(attempt: attempt, .failed("Your account page opened without signing in. Please try again."))]
        }
        return [.settleRedeem(attempt: attempt, .landed)]
    }

    /// `navigation` failed (never a cancellation; the adapter drops those).
    mutating func navigationFailed(_ navigation: ObjectIdentifier?, domain: String, code: Int, description: String) -> [SignInLoopEffect] {
        if let attempt = redeem, !attempt.readingCookie {
            guard let navigation = navigation, navigation == attempt.navigation else {
                return [.logError("Ignored a failed page load while a different navigation is the redeem in flight.")]
            }
            redeem = nil
            // Fixed text: the error's own description could quote the one-time redeem URL.
            return [.settleRedeem(attempt: attempt.id, .failed("Could not open your account page (\(domain) \(code)). Check your connection and try again."))]
        }
        return isParked ? [] : [.showFailure("\(description) (\(domain) \(code))")]
    }

    /// The web view's content process died: a redeem in flight ends with it.
    mutating func webContentTerminated() -> [SignInLoopEffect] {
        if let attempt = redeem, !attempt.readingCookie {
            redeem = nil
            return [.settleRedeem(attempt: attempt.id, .failed("The page stopped unexpectedly. Please try again."))]
        }
        return isParked ? [] : [.showFailure("The page stopped unexpectedly.")]
    }

    // MARK: The cap

    /// Records one automatic request at `now`; false when it is past the cap. Requests older than
    /// `window` no longer count.
    private mutating func admitAutomaticRequest(at now: Date) -> Bool {
        requestTimes.removeAll { now.timeIntervalSince($0) >= Self.window }
        requestTimes.append(now)
        return requestTimes.count <= Self.maxAutomaticRequests
    }

    /// The request that crossed the cap: park. Also ends a redeem in flight, so it cannot set a
    /// cookie and land on a page that asks again.
    private mutating func park() -> [SignInLoopEffect] {
        isParked = true
        requestTimes.removeAll()
        redeem = nil
        return [.stopLoading, .showSignInScreen, .parked]
    }

    private mutating func unpark() {
        isParked = false
        requestTimes.removeAll()
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
