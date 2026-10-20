import SwiftUI

/// Sign in (Apple / Google through the web OAuth flow), savings, data export,
/// data deletion, sign out.
struct AccountView: View {
    @EnvironmentObject private var session: SessionStore
    @EnvironmentObject private var favorites: FavoritesStore

    @State private var overview: LoadState<OverviewResponse> = .idle
    @State private var exportedFile: URL?
    @State private var exportError: String?
    @State private var isExporting = false
    @State private var confirmingDelete = false
    @State private var deleteMessage: String?

    var body: some View {
        NavigationStack {
            List {
                if let message = session.errorMessage {
                    Section { ErrorBanner(message: message, retryTitle: "Dismiss") { session.errorMessage = nil } }
                }
                if session.isSignedIn {
                    signedInSections
                } else {
                    signedOutSection
                }
                Section("About") {
                    Link(destination: URL(string: "https://grabcaramel.com/profile")!) {
                        Label("Your account on the web", systemImage: "safari")
                    }
                    Link(destination: URL(string: "https://grabcaramel.com")!) {
                        Label("grabcaramel.com", systemImage: "globe")
                    }
                }
            }
            .navigationTitle("Account")
            .task(id: session.token) {
                guard session.isSignedIn else { return }
                await loadOverview()
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
            Text("One sign-in covers the app and the Safari extension.")
        }
    }

    // MARK: Signed in

    @ViewBuilder
    private var signedInSections: some View {
        Section {
            Label(session.username ?? "Signed in", systemImage: "person.crop.circle.fill")
        }
        Section("Your savings") {
            switch overview {
            case .idle, .loading:
                ProgressView()
            case .failed(let message):
                ErrorBanner(message: message) { Task { await loadOverview() } }
            case .loaded(let data):
                savingsRows(data.savings)
            }
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
            // TODO(T-4906): Apple App Review guideline 5.1.1(v) requires in-app
            // account deletion. The only existing route (POST
            // /api/account/data/delete) deletes the synced data, NOT the
            // account or login, so a true "Delete account" button waits on a
            // web endpoint that removes the user and revokes their sessions.
        } header: {
            Text("Your data")
        }
        Section {
            Button("Sign out", role: .destructive) { session.signOut() }
        }
    }

    @ViewBuilder
    private func savingsRows(_ savings: OverviewResponse.Savings) -> some View {
        if savings.totals.isEmpty {
            Text(savings.syncEnabled
                ? "No savings recorded yet."
                : "Savings are not synced. Turn on savings sync in the Caramel extension to see totals here.")
                .foregroundStyle(.secondary)
        } else {
            ForEach(savings.totals, id: \.currency) { total in
                HStack {
                    Text("Saved (\(total.currency))")
                    Spacer()
                    Text(DiscountFormat.money(minorUnits: total.minorUnits, currency: total.currency)).bold()
                }
            }
            Text("\(savings.eventCount) \(savings.eventCount == 1 ? "saving" : "savings") across \(savings.storeCount) \(savings.storeCount == 1 ? "store" : "stores").")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Actions

    private func loadOverview() async {
        guard let token = session.token else { return }
        overview = .loading
        do {
            overview = .loaded(try await CaramelAPI.shared.overview(bearer: token))
        } catch let error as APIError where error.isUnauthorized {
            overview = .failed("Your session expired. Sign out and sign in again.")
        } catch is CancellationError {
            overview = .idle
        } catch {
            overview = .failed(error.localizedDescription)
        }
    }

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

    private func deleteData() async {
        guard let token = session.token else { return }
        deleteMessage = nil
        do {
            try await CaramelAPI.shared.deleteSyncedData(bearer: token)
            exportedFile = nil
            deleteMessage = "Your synced data was deleted."
            await favorites.refresh()
            await loadOverview()
        } catch {
            deleteMessage = "Could not delete: \(error.localizedDescription)"
        }
    }
}
