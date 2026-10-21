import AuthenticationServices
import SwiftUI

enum SignInError: LocalizedError {
    case couldNotStartSheet
    case cancelled
    case providerRefused
    case missingCode
    case stateMismatch

    var errorDescription: String? {
        switch self {
        case .couldNotStartSheet: return "The sign-in sheet could not be opened."
        case .cancelled: return "Sign-in was cancelled."
        case .providerRefused: return "The sign-in was cancelled or refused."
        case .missingCode: return "The sign-in did not return a code. Please try again."
        case .stateMismatch: return "The sign-in response did not match the request. Please try again."
        }
    }
}

/// Runs the web OAuth flow (Apple / Google) in an ASWebAuthenticationSession.
/// The flow ends with the web app redirecting to AppConfig.signInRedirectURI,
/// which closes the sheet and hands the callback URL (code + signed state)
/// back here.
@MainActor
final class WebSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var activeSession: ASWebAuthenticationSession?

    /// Presents the sheet and returns the callback URL it was redirected to.
    func authenticate(url: URL) async throws -> URL {
        defer { activeSession = nil }
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: AppConfig.signInCallbackScheme
            ) { callbackURL, error in
                if let callbackURL = callbackURL {
                    continuation.resume(returning: callbackURL)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: SignInError.cancelled)
                } else {
                    continuation.resume(throwing: error ?? SignInError.couldNotStartSheet)
                }
            }
            session.presentationContextProvider = self
            activeSession = session
            if !session.start() {
                continuation.resume(throwing: SignInError.couldNotStartSheet)
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        return windows.first(where: { $0.isKeyWindow }) ?? ASPresentationAnchor()
    }

    /// The code from a sign-in callback, after checking it answers THIS request:
    /// the web app echoes the signed state it issued, so a callback carrying
    /// anything else did not come from the flow we started.
    static func code(from callback: URL, expectedState: String) throws -> String {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first(where: { $0.name == name })?.value }
        if value("error") != nil { throw SignInError.providerRefused }
        guard value("state") == expectedState else { throw SignInError.stateMismatch }
        guard let code = value("code"), !code.isEmpty else { throw SignInError.missingCode }
        return code
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
            let start = try await api.oauthAuthorize(provider: provider)
            guard let url = URL(string: start.authorizationUrl) else {
                throw SignInError.couldNotStartSheet
            }
            let callback = try await webSignIn.authenticate(url: url)
            let code = try WebSignIn.code(from: callback, expectedState: start.state)
            let result = try await api.oauthExchange(provider: provider, code: code, state: start.state)
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

    /// Signs out: clears the on-device session (app + extension share it) and
    /// revokes the bearer on the server (DELETE /api/extension/session). The
    /// local session is cleared even when the revoke fails, so the shopper is
    /// never stuck signed in, and the failure is shown rather than swallowed.
    func signOut() async {
        let bearer = token
        clearLocalSession()
        guard let bearer = bearer else { return }
        do {
            try await api.revokeSession(bearer: bearer)
        } catch {
            errorMessage = "Signed out on this device, but the server could not end the session: \(error.localizedDescription)"
        }
    }

    /// Deletes the account on the server (POST /api/account/delete, which also
    /// ends every session, this one included) and clears the local session.
    /// Returns false, with errorMessage set, when the server refused: nothing
    /// was deleted and the shopper stays signed in.
    func deleteAccount() async -> Bool {
        guard let bearer = token else { return false }
        do {
            try await api.deleteAccount(bearer: bearer)
        } catch {
            errorMessage = "Could not delete your account: \(error.localizedDescription)"
            return false
        }
        clearLocalSession()
        return true
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
