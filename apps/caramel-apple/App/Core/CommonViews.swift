import SwiftUI

/// A visible failure with a retry, used wherever a request can fail.
struct ErrorBanner: View {
    let message: String
    let retryTitle: String
    let retry: () -> Void

    init(message: String, retryTitle: String = "Try again", retry: @escaping () -> Void) {
        self.message = message
        self.retryTitle = retryTitle
        self.retry = retry
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Something went wrong", systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.red)
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            Button(retryTitle, action: retry)
                .buttonStyle(.bordered)
        }
        .padding(.vertical, 4)
    }
}
