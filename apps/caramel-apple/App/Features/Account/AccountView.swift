import SwiftUI

/// The native account screen: sign in (Apple / Google through the web OAuth flow),
/// sign out, data export and deletion (App Review 5.1.1(v) account deletion stays
/// in-app), deal alerts, the privacy policy, and a door to the framed web account.
///
/// TODO(T-7842): "Your Caramel account" opens signed in now (T-7852 handoff), so the
/// native "Download my data" and "Delete my synced data" rows duplicate the web page.
/// Drop them once a device run confirms /profile offers both; account deletion stays
/// native either way (App Review 5.1.1(v)).
struct AccountView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var favorites: FavoritesStore
    @EnvironmentObject private var router: ShellRouter

    @State private var exportedFile: URL?
    @State private var exportError: String?
    @State private var isExporting = false
    @State private var confirmingDelete = false
    @State private var deleteMessage: String?
    @State private var confirmingAccountDelete = false

    var body: some View {
        NavigationStack {
            List {
                if let message = session.errorMessage, !ScreenshotLaunch.isActive {
                    Section { ErrorBanner(message: message, retryTitle: "Dismiss") { session.errorMessage = nil } }
                }
                if session.isSignedIn {
                    signedInSections
                } else {
                    signedOutSection
                }
                Section {
                    NavigationLink {
                        WebShellView(model: router.profile)
                            .navigationTitle("Your Caramel account")
                            .navigationBarTitleDisplayMode(.inline)
                    } label: {
                        Label("Your Caramel account", systemImage: "person.text.rectangle")
                    }
                } footer: {
                    Text("Savings, saved stores and preferences, on grabcaramel.com.")
                }
                AlertsSettingsSection()
                Section {
                    Link(destination: AppConfig.supportURL) {
                        Label("Help & support", systemImage: "questionmark.circle")
                    }
                    Link(destination: AppConfig.privacyPolicyURL) {
                        Label("Privacy policy", systemImage: "hand.raised")
                    }
                    Link(destination: AppConfig.websiteURL) {
                        Label("Website", systemImage: "globe")
                    }
                } header: {
                    Text("About")
                } footer: {
                    Text("Tell us what is blocking you and ask for a reply: a human replies within 1 business day.")
                }
            }
            .navigationTitle("Account")
            .alert("Delete your account?", isPresented: $confirmingAccountDelete) {
                Button("Delete account", role: .destructive) { Task { await deleteAccount() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently deletes your Caramel account, your sign-ins and all your synced data, and signs you out everywhere, including the Safari extension. This cannot be undone.")
            }
            .alert("Delete your synced data?", isPresented: $confirmingDelete) {
                Button("Delete", role: .destructive) { Task { await deleteData() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This removes the savings history, followed stores and code reports tied to your Caramel account. Your sign-in stays.")
            }
        }
    }

    // MARK: Signed out

    private var signedOutSection: some View {
        Section {
            Text("Sign in to keep saved stores across devices and see what Caramel has saved you.")
                .font(.subheadline)
            Button {
                Task { await session.signIn(with: .apple) }
            } label: {
                Label("Continue with Apple", systemImage: "applelogo")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.black)
            .disabled(session.isSigningIn)
            Button {
                Task { await session.signIn(with: .google) }
            } label: {
                Label("Continue with Google", systemImage: "g.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(session.isSigningIn)
            if session.isSigningIn {
                HStack {
                    ProgressView()
                    Text("Waiting for sign-in to finish...").font(.footnote).foregroundStyle(.secondary)
                }
            }
        } footer: {
            // TODO(T-5059): once native messaging shares the sign-in with the Safari extension, say so here.
            Text("The Safari extension has its own sign-in; signing in here does not sign it in.")
        }
    }

    // MARK: Signed in

    @ViewBuilder
    private var signedInSections: some View {
        Section {
            Label(session.username ?? "Signed in", systemImage: "person.crop.circle.fill")
        }
        Section {
            if let exportedFile = exportedFile {
                ShareLink(item: exportedFile) {
                    Label("Share your data export", systemImage: "square.and.arrow.up")
                }
            } else {
                Button {
                    Task { await exportData() }
                } label: {
                    Label(isExporting ? "Preparing..." : "Download my data", systemImage: "arrow.down.doc")
                }
                .disabled(isExporting)
            }
            if let exportError = exportError {
                Text(exportError).font(.footnote).foregroundStyle(.red)
            }
            Button(role: .destructive) {
                confirmingDelete = true
            } label: {
                Label("Delete my synced data", systemImage: "trash")
            }
            if let deleteMessage = deleteMessage {
                Text(deleteMessage).font(.footnote).foregroundStyle(.secondary)
            }
            // Apple App Review guideline 5.1.1(v): in-app account deletion.
            Button(role: .destructive) {
                confirmingAccountDelete = true
            } label: {
                Label("Delete my account", systemImage: "person.crop.circle.badge.xmark")
            }
        } header: {
            Text("Your data")
        }
        Section {
            Button("Sign out", role: .destructive) {
                Task {
                    // CaramelApp resets the web shells when the token goes away.
                    await session.signOut()
                }
            }
        }
    }

    // MARK: Actions

    private func exportData() async {
        guard let token = session.token else { return }
        isExporting = true
        exportError = nil
        defer { isExporting = false }
        do {
            let data = try await CaramelAPI.shared.exportData(bearer: token)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("caramel-data-export.json")
            try data.write(to: url, options: .atomic)
            exportedFile = url
        } catch {
            exportError = error.localizedDescription
        }
    }

    private func deleteAccount() async {
        // On success the session is cleared and the view swaps to the signed-out
        // state; on failure SessionStore.errorMessage shows the banner.
        if await session.deleteAccount() {
            exportedFile = nil
            await favorites.refresh()
        }
    }

    private func deleteData() async {
        guard let token = session.token else { return }
        deleteMessage = nil
        do {
            try await CaramelAPI.shared.deleteSyncedData(bearer: token)
            exportedFile = nil
            deleteMessage = "Your synced data was deleted."
            await favorites.refresh()
        } catch {
            deleteMessage = "Could not delete: \(error.localizedDescription)"
        }
    }
}
