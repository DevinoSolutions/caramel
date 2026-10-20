import Foundation

enum AppConfig {
    /// Shared with the Safari Web Extension (same entitlement on both targets)
    /// so one sign-in can later cover both.
    /// TODO(T-4905): nothing reads or writes this container yet.
    static let appGroupIdentifier = "group.com.devino.Caramel"
}
