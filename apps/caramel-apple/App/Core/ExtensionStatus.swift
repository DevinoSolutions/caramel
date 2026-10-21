import SwiftUI

/// Whether the Safari extension is switched on, as the container app can know it.
///
/// iOS gives an app no API to ask "is my Safari extension enabled". The signal
/// is the extension's own native-messaging ping: SafariWebExtensionHandler
/// stamps `AppGroup.Key.extensionLastPingAt` and this reads it.
///
/// TODO(T-4905): the extension does not send the ping yet (see
/// SafariWebExtensionHandler), so `.detected` cannot happen today and
/// onboarding relies on `.confirmedByUser`, which the shopper sets by hand.
@MainActor
final class ExtensionStatus: ObservableObject {
    enum State: Equatable {
        case detected(lastSeen: Date)
        case confirmedByUser
        case notDetected
    }

    /// A ping older than this no longer counts as "enabled".
    static let pingFreshness: TimeInterval = 30 * 24 * 60 * 60

    @Published private(set) var state: State = .notDetected

    init() {
        refresh()
    }

    func refresh() {
        let defaults = AppGroup.defaults
        let pingedAt = defaults.double(forKey: AppGroup.Key.extensionLastPingAt)
        if pingedAt > 0 {
            let lastSeen = Date(timeIntervalSince1970: pingedAt)
            if Date().timeIntervalSince(lastSeen) < Self.pingFreshness {
                state = .detected(lastSeen: lastSeen)
                return
            }
        }
        state = defaults.bool(forKey: AppGroup.Key.onboardingConfirmedByUser) ? .confirmedByUser : .notDetected
    }

    func setConfirmedByUser(_ confirmed: Bool) {
        AppGroup.defaults.set(confirmed, forKey: AppGroup.Key.onboardingConfirmedByUser)
        refresh()
    }
}
