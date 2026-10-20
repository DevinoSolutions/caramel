import AuthenticationServices
import SwiftUI

enum SignInError: LocalizedError {
    case couldNotStartSheet
    case cancelled
    case timedOut

    var errorDescription: String? {
        switch self {
        case .couldNotStartSheet: return "The sign-in sheet could not be opened."
        case .cancelled: return "Sign-in was cancelled."
        case .timedOut: return "Sign-in took too long. Please try again."
        }
    }
}

/// Runs the existing web OAuth flow (Apple / Google) in an
/// ASWebAuthenticationSession and collects the result the way the shipped
/// Safari extension does: the flow ends on a "Sign-in successful" web page and
/// the session token is fetched from /api/extension/oauth/poll with the nonce.
///
/// TODO(T-4906): this polling flow is the web side's `safari-shim-removal`
/// compatibility shim. Keep it until the web app serves a real app redirect
/// (custom scheme or universal link) that closes the sheet itself; then
/// replace the polling here with the redirect callback.
@MainActor
final class WebSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var sheetClosed = false

    func authenticate(url: URL, nonce: String, api: CaramelAPI) async throws -> OAuthPollResult {
        sheetClosed = false
        let session = ASWebAuthenticationSession(
            url: url,
            callbackURLScheme: AppConfig.signInCallbackScheme
        ) { [weak self] _, _ in
            Task { @MainActor in self?.sheetClosed = true }
        }
        session.presentationContextProvider = self
        guard session.start() else { throw SignInError.couldNotStartSheet }
        // Dismisses the sheet as soon as the token (or a failure) is in hand.
        defer { session.cancel() }

        let deadline = Date().addingTimeInterval(5 * 60)
        var pollsAfterClose = 2
        var consecutivePollErrors = 0
        while Date() < deadline {
            try await Task.sleep(nanoseconds: 2_000_000_000)
            do {
                if let result = try await api.oauthPoll(nonce: nonce) { return result }
                consecutivePollErrors = 0
            } catch let error as APIError where error.isFinalRefusal {
                // A 4xx (the 400 failure sentinel, a bad nonce) is the server's final answer.
                throw error
            } catch let error as APIError {
                // No response, a 5xx or a 429: a flaky network must not abort a sign-in
                // the shopper already finished, so allow a few in a row.
                consecutivePollErrors += 1
                if consecutivePollErrors > 3 { throw error }
            }
            if sheetClosed {
                // The shopper may have tapped Done right after the page said
                // "signed in": allow a final poll or two before giving up.
                pollsAfterClose -= 1
                if pollsAfterClose <= 0 { throw SignInError.cancelled }
            }
        }
        throw SignInError.timedOut
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        return windows.first(where: { $0.isKeyWindow }) ?? ASPresentationAnchor()
    }
}

/// The signed-in state. The bearer lives in the shared keychain
/// (SharedSessionKeychain) so the Safari extension can read the same sign-in.
@MainActor
final class SessionStore: ObservableObject {
    @Published private(set) var token: String?
    @Published private(set) var username: String?
    @Published private(set) var isSigningIn = false
    @Published var errorMessage: String?

    var isSignedIn: Bool { token != nil }

    private let api = CaramelAPI.shared
    private let webSignIn = WebSignIn()

    init() {
        do {
            token = try SharedSessionKeychain.read()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Confirms the stored bearer is still alive (a 401 means it expired or was revoked).
    func validate() async {
        guard let token = token else { return }
        do {
            let me = try await api.me(bearer: token)
            username = me.username
        } catch let error as APIError where error.isUnauthorized {
            clearLocalSession()
            errorMessage = "Your session expired. Please sign in again."
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signIn(with provider: OAuthProvider) async {
        isSigningIn = true
        errorMessage = nil
        defer { isSigningIn = false }
        do {
            let nonce = UUID().uuidString
            let start = try await api.oauthAuthorize(provider: provider, nonce: nonce)
            guard let url = URL(string: start.authorizationUrl) else {
                throw SignInError.couldNotStartSheet
            }
            let result = try await webSignIn.authenticate(url: url, nonce: nonce, api: api)
            try SharedSessionKeychain.write(result.token)
            token = result.token
            username = result.username
        } catch SignInError.cancelled {
            // The shopper backed out: not an error to report.
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Clears the on-device session (app + extension share it).
    /// TODO(T-4906): there is no server-side revoke endpoint for the bearer, so
    /// the token stays valid on the server until it expires (7 days).
    func signOut() {
        clearLocalSession()
    }

    private func clearLocalSession() {
        do {
            try SharedSessionKeychain.delete()
        } catch {
            errorMessage = error.localizedDescription
        }
        token = nil
        username = nil
    }
}
