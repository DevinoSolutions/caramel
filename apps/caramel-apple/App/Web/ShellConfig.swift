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
/// agent through `WKWebViewConfiguration.applicationNameForUserAgent`.
enum ShellUserAgent {
    /// TODO(T-4905): "macos" once a macOS target exists (project.yml is iOS only).
    static let platform = "ios"

    static func applicationName(version: String) -> String {
        "CaramelApp/\(version) (\(platform))"
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
