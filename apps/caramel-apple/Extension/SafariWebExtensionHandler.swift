import SafariServices

/// Native-messaging entry point of the Safari Web Extension.
///
/// TODO(T-4905): the extension does not send native messages yet. The planned
/// "enabled" ping (extension to the App Group `group.com.devino.Caramel`, read
/// by the container app's onboarding) lands with the container features. Until
/// then this handler accepts a request and returns nothing, so the extension
/// target links, signs and embeds like the converter-built one did.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: [], completionHandler: nil)
    }
}
