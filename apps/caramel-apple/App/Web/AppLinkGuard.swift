import Foundation

/// The one gate every URL passes before the web shell loads it (T-7842, T-7817).
/// The iOS twin of Android's AppLinkGuard.
///
/// The check is on the URL STRING, never on `URL.host`: Foundation's URL parser
/// is lenient (it accepts and normalizes backslashes, userinfo, odd ports, and
/// stray whitespace), and a host comparison would then wave through strings like
/// `https://grabcaramel.com\@evil.com`. A string is accepted only when it is
/// exactly `https://grabcaramel.com`, or that origin followed by `/`, `?` or `#`,
/// and it carries no whitespace, control, separator, format or backslash
/// character anywhere.
///
/// Pure Foundation on purpose: the file is compiled into the CaramelTests bundle
/// as well, which runs without the app.
enum AppLinkGuard {
    static let origin = "https://grabcaramel.com"

    /// What the shell does with a URL it was asked to navigate to.
    enum Decision: Equatable {
        /// On the Caramel origin: load it inside the shell.
        case loadInShell(URL)
        /// /login or /signup: Google blocks OAuth in web views, so run the native sign-in instead.
        case signIn
        /// Another website: Safari, where the Caramel extension works.
        case openInBrowser(URL)
        /// mailto: / tel: go to the system.
        case openInSystem(URL)
        /// A frame embedded in a page (not a navigation of the shell): https content, or the about: placeholders, may load.
        case allowEmbedded
        /// An external open (Safari, mail, phone) that no tap asked for, e.g. `location.href = ...`. Cancelled, with a notice.
        case blockedExternal
        /// Refused. `reason` goes to the log, never into a user-visible URL.
        case cancel(reason: String)
    }

    // MARK: String gate

    /// True when `candidate` is the Caramel origin or a URL under it.
    static func isAllowed(_ candidate: String) -> Bool {
        if containsForbiddenCharacter(candidate) { return false }
        let originBytes = Array(origin.utf8)
        let bytes = Array(candidate.utf8)
        guard bytes.starts(with: originBytes) else { return false }
        if bytes.count == originBytes.count { return true }
        switch bytes[originBytes.count] {
        case UInt8(ascii: "/"), UInt8(ascii: "?"), UInt8(ascii: "#"): return true
        default: return false
        }
    }

    /// The URL for `candidate` when the string gate accepts it.
    static func allowedURL(_ candidate: String) -> URL? {
        isAllowed(candidate) ? URL(string: candidate) : nil
    }

    /// Whitespace, C0/C1 control characters, DEL, Unicode separators and format
    /// characters (U+2028/2029, U+200B, U+FEFF, ...), and the backslash.
    static func containsForbiddenCharacter(_ candidate: String) -> Bool {
        candidate.unicodeScalars.contains { scalar in
            if scalar == "\\" || scalar.properties.isWhitespace { return true }
            switch scalar.properties.generalCategory {
            case .control, .format, .spaceSeparator, .lineSeparator, .paragraphSeparator: return true
            default: return false
            }
        }
    }

    // MARK: Navigation decision

    /// What started a navigation, reduced to what the gesture gate needs.
    enum NavigationKind: Equatable {
        /// A tapped link (WKNavigationType.linkActivated).
        case linkActivated
        /// A submitted form (WKNavigationType.formSubmitted).
        case formSubmitted
        /// Script (`location.href`, `window.open`), redirects, reloads, back/forward.
        case other
    }

    /// Leaving the app for Safari, Mail or the dialer needs a tap or a form
    /// submit. Without one the page could launch them on its own, so the open is
    /// replaced by `.blockedExternal`. Decisions that stay in the shell, or that
    /// are already refusals, are unchanged.
    static func gate(_ decision: Decision, kind: NavigationKind) -> Decision {
        switch decision {
        case .openInBrowser, .openInSystem:
            return kind == .other ? .blockedExternal : decision
        default:
            return decision
        }
    }

    /// The path's non-empty segments, so `//login` and `/login/` read as `login`.
    /// `URLComponents.path` is already percent-decoded.
    static func pathSegments(of url: URL) -> [String] {
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? ""
        return path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    }

    private static let signInSegments: Set<String> = ["login", "signup"]

    /// `isMainFrame` is false for iframes. Their loads are not navigations of the
    /// shell (an iframe that navigates the TOP frame is a main-frame decision), so
    /// they are never sent to Safari: https frames and the about:blank/srcdoc
    /// placeholders may load, anything else is refused.
    static func decision(for url: URL, isMainFrame: Bool) -> Decision {
        let string = url.absoluteString
        let scheme = url.scheme?.lowercased()

        if !isMainFrame {
            if containsForbiddenCharacter(string) {
                return .cancel(reason: "frame URL contains whitespace, a control/separator/format character or a backslash")
            }
            if scheme == "https" || string == "about:blank" || string == "about:srcdoc" {
                return .allowEmbedded
            }
            return .cancel(reason: "frame scheme \(scheme ?? "none") is not allowed")
        }

        if isAllowed(string) {
            let segments = pathSegments(of: url)
            let isSignInPage = segments.count == 1 && signInSegments.contains(segments[0])
            return isSignInPage ? .signIn : .loadInShell(url)
        }

        if containsForbiddenCharacter(string) {
            return .cancel(reason: "URL contains whitespace, a control/separator/format character or a backslash")
        }
        switch scheme {
        case "http", "https":
            guard let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else {
                return .cancel(reason: "web URL without a host, or with credentials in it")
            }
            return .openInBrowser(url)
        case "mailto", "tel":
            return .openInSystem(url)
        default:
            return .cancel(reason: "scheme \(scheme ?? "none") is not allowed")
        }
    }

    // MARK: Incoming links

    /// Where an incoming link (onOpenURL, universal link) may land: `/`, `/coupons*`,
    /// `/profile*`, `/privacy`, `/support`. Anything else on the origin goes home
    /// (Deals), and a URL the string gate refuses is nil (ignored, logged).
    static func incomingTarget(for url: URL, home: URL) -> URL? {
        guard isAllowed(url.absoluteString) else { return nil }
        let segments = pathSegments(of: url)
        guard let first = segments.first else { return url }
        switch (first, segments.count) {
        case ("coupons", _), ("profile", _), ("privacy", 1), ("support", 1):
            return url
        default:
            return home
        }
    }
}
