import SafariServices

/// Native-messaging entry point of the Safari Web Extension. The extension
/// sends `{ type, ... }` messages; each gets exactly one `{ ok, ... }` reply
/// (an unknown type or a failure replies `ok: false` with an `error`, never
/// silence).
///
///  - `ping`       the extension is running: stamp the time (and its version) in
///                 the App Group so the container app's onboarding can show
///                 "enabled". The app reads `AppGroup.Key.extensionLastPingAt`.
///  - `getSession` reply with the bearer the container app stored in the shared
///                 keychain (`token` is absent when the shopper is signed out).
///
/// TODO(T-4905): nothing in the extension sends these messages yet. Wiring it
/// needs (1) a Safari-only `nativeMessaging` permission, added in
/// scripts/derive-safari-build.sh so Chrome/Firefox manifests (and their store
/// permission prompts) stay untouched, and (2) a guarded
/// `browser.runtime.sendNativeMessage` call from background.js. Until then the
/// app's onboarding falls back to the shopper's own confirmation.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply(to: message)]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    private func reply(to message: [String: Any]?) -> [String: Any] {
        guard let type = message?["type"] as? String else {
            return ["ok": false, "error": "Native message has no string `type`."]
        }
        switch type {
        case "ping":
            AppGroup.defaults.set(Date().timeIntervalSince1970, forKey: AppGroup.Key.extensionLastPingAt)
            if let version = message?["version"] as? String {
                AppGroup.defaults.set(version, forKey: AppGroup.Key.extensionLastPingVersion)
            }
            return ["ok": true]
        case "getSession":
            do {
                var reply: [String: Any] = ["ok": true]
                if let token = try SharedSessionKeychain.read() {
                    reply["token"] = token
                }
                return reply
            } catch {
                return ["ok": false, "error": error.localizedDescription]
            }
        default:
            return ["ok": false, "error": "Unknown native message type `\(type)`."]
        }
    }
}
