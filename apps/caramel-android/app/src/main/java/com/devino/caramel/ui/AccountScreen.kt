package com.devino.caramel.ui

import android.content.ActivityNotFoundException
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import com.devino.caramel.AppContainer
import com.devino.caramel.core.ApiError
import com.devino.caramel.core.AppConfig
import com.devino.caramel.core.DiscountFormat
import com.devino.caramel.core.LoadState
import com.devino.caramel.core.OAuthProvider
import com.devino.caramel.core.OverviewResponse
import com.devino.caramel.core.SessionState
import kotlinx.coroutines.launch
import java.io.IOException

private const val EXPORT_FILE_NAME = "caramel-data-export.json"

/** Sign in (Apple / Google through the web OAuth flow), savings, data export, data deletion, account deletion, sign out. */
@Composable
fun AccountScreen(container: AppContainer, session: SessionState, onStartSignIn: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val uriHandler = LocalUriHandler.current

    var linkMessage by remember { mutableStateOf<String?>(null) }
    val openLink: (String) -> Unit = { url ->
        try {
            uriHandler.openUri(url)
        } catch (e: IllegalArgumentException) {
            // LocalUriHandler throws when no app can open the link (no browser installed).
            linkMessage = "No web browser is installed to open this link: ${e.message}"
        }
    }

    var overview by remember { mutableStateOf<LoadState<OverviewResponse>>(LoadState.Idle) }
    var isExporting by remember { mutableStateOf(false) }
    var exportMessage by remember { mutableStateOf<String?>(null) }
    var deleteMessage by remember { mutableStateOf<String?>(null) }
    var confirmingDataDelete by remember { mutableStateOf(false) }
    var confirmingAccountDelete by remember { mutableStateOf(false) }

    val saveExport = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        // Held by the app container, not by this composable, so a rotation while the file picker is
        // open does not lose the export. (A reclaimed process does lose it: that is reported below.)
        val bytes = container.pendingExport.take()
        if (uri != null && bytes == null) {
            exportMessage = "Could not save the export: it was lost while the file picker was open. Please download it again."
        } else if (uri != null && bytes != null) {
            exportMessage = try {
                val out = context.contentResolver.openOutputStream(uri) ?: throw IOException("The chosen location could not be opened.")
                out.use { it.write(bytes) }
                "Your data export was saved."
            } catch (e: IOException) {
                "Could not save the export: ${e.message}"
            }
        }
    }

    suspend fun loadOverview() {
        val token = session.token ?: return
        overview = LoadState.Loading
        overview = try {
            LoadState.Loaded(container.api.overview(token))
        } catch (e: ApiError) {
            if (e.isUnauthorized) LoadState.Failed("Your session expired. Sign out and sign in again.") else LoadState.Failed(e.message ?: "Request failed")
        }
    }

    LaunchedEffect(session.token) {
        if (session.isSignedIn) loadOverview()
    }

    ScreenScaffold(title = "Account") { padding ->
        Column(
            modifier = Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            session.errorMessage?.let { ErrorBanner(it, retryTitle = "Dismiss") { container.session.dismissError() } }

            if (session.isSignedIn) {
                SectionTitle(session.username ?: "Signed in")
                SectionTitle("Your savings")
                LoadStateContent(overview, onRetry = { scope.launch { loadOverview() } }) { SavingsRows(it.savings) }

                SectionTitle("Your data")
                OutlinedButton(
                    enabled = !isExporting,
                    onClick = {
                        scope.launch {
                            val token = session.token ?: return@launch
                            isExporting = true
                            exportMessage = null
                            try {
                                container.pendingExport.bytes = container.api.exportData(token)
                                saveExport.launch(EXPORT_FILE_NAME)
                            } catch (e: ApiError) {
                                exportMessage = "Could not prepare the export: ${e.message}"
                            } catch (e: ActivityNotFoundException) {
                                // No app on this device can create a document (some Fire builds): drop the bytes.
                                container.pendingExport.take()
                                exportMessage = "This device has no app to save the export with: ${e.message}"
                            } finally {
                                isExporting = false
                            }
                        }
                    },
                ) { Text(if (isExporting) "Preparing..." else "Download my data") }
                exportMessage?.let { Footnote(it) }
                OutlinedButton(onClick = { confirmingDataDelete = true }) { Text("Delete my synced data") }
                deleteMessage?.let { Footnote(it) }
                // Google Play account-deletion policy: in-app account deletion, same endpoint as iOS.
                OutlinedButton(onClick = { confirmingAccountDelete = true }) {
                    Text("Delete my account", color = MaterialTheme.colorScheme.error)
                }
                Button(onClick = { scope.launch { container.session.signOut() } }) { Text("Sign out") }
            } else {
                SectionTitle("Account")
                Text("Sign in to keep saved stores across devices and see what Caramel has saved you.", style = MaterialTheme.typography.bodyMedium)
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !session.isSigningIn,
                    onClick = { scope.launch { container.session.beginSignIn(OAuthProvider.APPLE)?.let(onStartSignIn) } },
                ) { Text("Continue with Apple") }
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !session.isSigningIn,
                    onClick = { scope.launch { container.session.beginSignIn(OAuthProvider.GOOGLE)?.let(onStartSignIn) } },
                ) { Text("Continue with Google") }
                if (session.isSigningIn) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        CircularProgressIndicator(modifier = Modifier.padding(4.dp))
                        Footnote("Waiting for sign-in to finish...")
                    }
                }
            }

            HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
            SectionTitle("About")
            TextButton(onClick = { openLink(AppConfig.SUPPORT_URL) }) { Text("Help & support") }
            TextButton(onClick = { openLink(AppConfig.PRIVACY_POLICY_URL) }) { Text("Privacy policy") }
            TextButton(onClick = { openLink(AppConfig.WEBSITE_URL) }) { Text("Website") }
            if (session.isSignedIn) {
                TextButton(onClick = { openLink(AppConfig.WEB_ACCOUNT_URL) }) { Text("Your account on the web") }
            }
            linkMessage?.let { Footnote(it) }
            Footnote("Tell us what is blocking you and ask for a reply: a human replies within 1 business day.")
        }
    }

    if (confirmingAccountDelete) {
        AlertDialog(
            onDismissRequest = { confirmingAccountDelete = false },
            title = { Text("Delete your account?") },
            text = {
                Text("This permanently deletes your Caramel account, your sign-ins and all your synced data, and signs you out everywhere. This cannot be undone.")
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmingAccountDelete = false
                    scope.launch {
                        // On success the session clears and the screen swaps to signed out; on
                        // failure SessionStore.errorMessage shows the banner.
                        if (container.session.deleteAccount()) overview = LoadState.Idle
                    }
                }) { Text("Delete account", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmingAccountDelete = false }) { Text("Cancel") } },
        )
    }
    if (confirmingDataDelete) {
        AlertDialog(
            onDismissRequest = { confirmingDataDelete = false },
            title = { Text("Delete your synced data?") },
            text = {
                Text("This removes the savings history, followed stores and code reports tied to your Caramel account. Your sign-in stays.")
            },
            confirmButton = {
                TextButton(onClick = {
                    confirmingDataDelete = false
                    scope.launch {
                        val token = session.token ?: return@launch
                        deleteMessage = try {
                            container.api.deleteSyncedData(token)
                            container.favorites.refresh()
                            loadOverview()
                            "Your synced data was deleted."
                        } catch (e: ApiError) {
                            "Could not delete: ${e.message}"
                        }
                    }
                }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmingDataDelete = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SavingsRows(savings: OverviewResponse.Savings) {
    if (savings.totals.isEmpty()) {
        Hint(
            if (savings.syncEnabled) {
                "No savings recorded yet."
            } else {
                "Savings are not synced. Turn on savings sync in the Caramel extension to see totals here."
            },
        )
        return
    }
    savings.totals.forEach { total ->
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Saved (${total.currency})")
            Text(DiscountFormat.money(total.minorUnits, total.currency), style = MaterialTheme.typography.titleSmall)
        }
    }
    Footnote(
        "${savings.eventCount} ${if (savings.eventCount == 1) "saving" else "savings"} across " +
            "${savings.storeCount} ${if (savings.storeCount == 1) "store" else "stores"}.",
    )
}
