import SwiftUI

/// Walks the shopper through turning the Safari extension on.
///
/// COPY SOURCE: the iPhone/iPad route below is the same sentence as
/// apps/caramel-extension/entrypoints/popup/components/SafariAllSitesSteps.tsx
/// (walked on an iOS 26 simulator, 2026-10-19: the page-menu icon at the left of
/// the address bar, then Always Allow > Always Allow on Every Website). Keep the
/// two in step; apps/caramel-extension/tests/apple-container-parity.test.mjs
/// fails when they drift.
enum OnboardingCopy {
    static let openSettings = "Open the Settings app, then go to Safari > Extensions. (On iOS 18 and later it is Settings > Apps > Safari > Extensions.)"
    static let turnOn = "Tap Caramel and turn on Allow Extension."
    static let allowEverySite = "In Safari, tap the page menu at the left of the address bar, choose Caramel, then Always Allow > Always Allow on Every Website."
}

struct OnboardingView: View {
    @EnvironmentObject private var extensionStatus: ExtensionStatus

    var body: some View {
        NavigationStack {
            List {
                Section { statusRow }
                Section("Turn Caramel on in Safari") {
                    StepRow(number: 1, text: OnboardingCopy.openSettings)
                    StepRow(number: 2, text: OnboardingCopy.turnOn)
                    StepRow(number: 3, text: OnboardingCopy.allowEverySite)
                }
                Section {
                    Button {
                        openURL(UIApplication.openSettingsURLString)
                    } label: {
                        Label("Open Settings", systemImage: "gearshape")
                    }
                    Button {
                        openURL("https://grabcaramel.com")
                    } label: {
                        Label("Open Safari", systemImage: "safari")
                    }
                } footer: {
                    Text("Settings cannot jump straight to Safari's extensions list, so Open Settings lands on Caramel's own page.")
                }
                if case .detected = extensionStatus.state {
                    EmptyView()
                } else {
                    Section {
                        Toggle("I turned Caramel on", isOn: confirmedBinding)
                    } footer: {
                        Text("Caramel shows a check here by itself once it has run in Safari. Until then, tell us when you are done.")
                    }
                }
            }
            .navigationTitle("Get started")
            .onAppear { extensionStatus.refresh() }
        }
    }

    @ViewBuilder
    private var statusRow: some View {
        switch extensionStatus.state {
        case .detected(let lastSeen):
            Label {
                VStack(alignment: .leading) {
                    Text("Caramel is on in Safari").font(.headline)
                    Text("Last seen \(lastSeen.formatted(date: .abbreviated, time: .omitted))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "checkmark.seal.fill").foregroundStyle(.green)
            }
        case .confirmedByUser:
            Label {
                Text("You marked Caramel as turned on").font(.headline)
            } icon: {
                Image(systemName: "checkmark.circle").foregroundStyle(.green)
            }
        case .notDetected:
            Label {
                Text("Caramel is not on yet").font(.headline)
            } icon: {
                Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
            }
        }
    }

    private var confirmedBinding: Binding<Bool> {
        Binding(
            get: { extensionStatus.state == .confirmedByUser },
            set: { extensionStatus.setConfirmedByUser($0) }
        )
    }

    private func openURL(_ string: String) {
        guard let url = URL(string: string) else { return }
        UIApplication.shared.open(url)
    }
}

private struct StepRow: View {
    let number: Int
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(.subheadline.bold())
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(Color.orange, in: Circle())
            Text(text)
        }
        .padding(.vertical, 2)
    }
}
