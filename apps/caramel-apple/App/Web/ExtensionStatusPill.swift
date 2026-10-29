import SwiftUI

/// The Safari extension's state, kept visible above every web screen. Tapping it
/// goes back to the native "Get started" walkthrough.
struct ExtensionStatusPill: View {
    @EnvironmentObject private var extensionStatus: ExtensionStatus
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                Image(systemName: symbol).foregroundStyle(tint)
                Text(label).font(.footnote.weight(.semibold))
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(tint.opacity(0.12), in: Capsule())
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityHint("Opens the Safari extension setup steps")
    }

    private var label: String {
        switch extensionStatus.state {
        case .detected: return "Safari extension: on"
        case .confirmedByUser: return "Safari extension: on (marked by you)"
        case .notDetected: return "Safari extension: not detected. Tap to set up"
        }
    }

    private var symbol: String {
        switch extensionStatus.state {
        case .detected, .confirmedByUser: return "checkmark.seal.fill"
        case .notDetected: return "exclamationmark.circle.fill"
        }
    }

    private var tint: Color {
        switch extensionStatus.state {
        case .detected, .confirmedByUser: return .green
        case .notDetected: return .orange
        }
    }
}
