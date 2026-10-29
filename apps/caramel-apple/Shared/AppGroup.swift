import Foundation
import Security

/// Storage shared by the container app and the Safari Web Extension. Compiled
/// into BOTH targets (project.yml `Shared`), so the two sides cannot disagree
/// about a key name or the keychain item.
enum AppGroup {
    static let identifier = "group.com.devino.Caramel"

    /// App Group UserDefaults. Fails loudly (not an optional) because a target
    /// without the application-groups entitlement would otherwise lose every
    /// write silently.
    static let defaults: UserDefaults = {
        guard let defaults = UserDefaults(suiteName: identifier) else {
            preconditionFailure("App Group \(identifier) is unavailable: the target is missing the com.apple.security.application-groups entitlement.")
        }
        return defaults
    }()

    enum Key {
        /// TimeInterval since 1970, written by SafariWebExtensionHandler on every extension "ping".
        static let extensionLastPingAt = "extensionLastPingAt"
        static let extensionLastPingVersion = "extensionLastPingVersion"
        /// The shopper confirmed the onboarding steps by hand (see ExtensionStatus).
        static let onboardingConfirmedByUser = "onboardingConfirmedByUser"
        /// Mirror of the saved-stores list ([String]); the account list when signed in, the only list when not.
        static let savedStores = "savedStores"
        /// [String] saved stores not yet confirmed by the account (signed in only); a sync never drops these.
        static let savedStoresPendingPush = "savedStoresPendingPush"
        static let alertsNotifyEnabled = "alertsNotifyEnabled"
        /// [String] saved stores whose web page was opened since the last alerts check (AlertsEngine.noteVisited).
        static let alertsVisitedStores = "alertsVisitedStores"
        /// [String: Int] store -> coupon total the shopper last looked at.
        static let alertsLastSeenTotals = "alertsLastSeenTotals"
        /// [String: Int] store -> coupon total a notification was last sent for.
        static let alertsLastNotifiedTotals = "alertsLastNotifiedTotals"
    }
}

/// The Caramel session bearer (the raw session token `POST /api/extension/oauth`
/// mints, the same one the browser extension keeps in its storage), in the
/// keychain. TODO(T-5059): the item is stored where the Safari extension could
/// read it, but nothing in the extension reads it yet, so the app's sign-in is
/// not shared with it today.
///
/// Both targets list the same single `keychain-access-groups` entry
/// (project.yml). The item names that group explicitly: its full value (team
/// prefix included) is stamped into both Info.plists as
/// `CaramelKeychainAccessGroup` at build time, so nothing hardcodes the team id.
/// Data-protection keychain, this device only (a bearer must not ride an
/// iCloud/backup restore onto another device).
enum SharedSessionKeychain {
    struct KeychainError: LocalizedError {
        let operation: String
        let status: OSStatus
        var errorDescription: String? {
            "Keychain \(operation) failed (OSStatus \(status))."
        }
    }

    private static let service = "com.devino.Caramel.session"
    private static let account = "extension-bearer"

    private static var accessGroup: String {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "CaramelKeychainAccessGroup") as? String,
              !group.isEmpty, !group.contains("$(") else {
            preconditionFailure("Info.plist has no resolved CaramelKeychainAccessGroup: check project.yml info.properties on this target.")
        }
        return group
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    static func read() throws -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw KeychainError(operation: "read", status: status)
        }
        guard let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
            throw KeychainError(operation: "decode", status: errSecDecode)
        }
        return token
    }

    static func write(_ token: String) throws {
        let data = Data(token.utf8)
        let updateStatus = SecItemUpdate(
            baseQuery() as CFDictionary,
            [kSecValueData as String: data] as CFDictionary
        )
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainError(operation: "update", status: updateStatus)
        }
        var add = baseQuery()
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(add as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError(operation: "add", status: addStatus)
        }
    }

    static func delete() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(operation: "delete", status: status)
        }
    }
}
