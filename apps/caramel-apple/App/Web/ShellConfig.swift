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
        guard domain.range(of: "^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", options: .regularExpression) != nil else { return nil }
        return AppLinkGuard.allowedURL("\(AppLinkGuard.origin)/coupons/\(domain)")
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
