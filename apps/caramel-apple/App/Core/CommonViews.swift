import SwiftUI

/// The state of one network-backed screen section.
enum LoadState<Value> {
    case idle
    case loading
    case loaded(Value)
    case failed(String)
}

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

/// One store in a list: its domain, a link to its codes, a saved marker.
struct StoreRow: View {
    let domain: String
    var isSaved: Bool = false
    var newCodes: Int = 0

    var body: some View {
        HStack {
            Image(systemName: "bag")
                .foregroundStyle(Color.orange)
            Text(domain)
            Spacer()
            if newCodes > 0 {
                Text("\(newCodes) new")
                    .font(.caption.bold())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Color.orange.opacity(0.2), in: Capsule())
            }
            if isSaved {
                Image(systemName: "heart.fill")
                    .foregroundStyle(Color.orange)
                    .accessibilityLabel("Saved")
            }
        }
    }
}
