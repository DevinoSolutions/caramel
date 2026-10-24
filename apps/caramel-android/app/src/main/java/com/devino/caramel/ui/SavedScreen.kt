package com.devino.caramel.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.devino.caramel.core.FavoritesState
import com.devino.caramel.core.FavoritesStore
import kotlinx.coroutines.launch

/**
 * Saved stores. TODO(T-7474): the iOS tab also has a "Notify me about new codes" local-notification
 * toggle (AlertsEngine, BGTaskScheduler); the Android twin has no alerts yet, and this screen does
 * not offer a control that would do nothing.
 */
@Composable
fun SavedScreen(favoritesStore: FavoritesStore, favorites: FavoritesState, onOpenStore: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    ScreenScaffold(title = "Saved") { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            favorites.errorMessage?.let { message ->
                ErrorBanner(message, retryTitle = "Dismiss") { favoritesStore.dismissError() }
            }
            if (favorites.stores.isEmpty()) {
                Text("No saved stores yet", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 24.dp))
                Hint("Tap the heart on a store's page to keep it here.")
            } else {
                favorites.stores.forEach { store ->
                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(modifier = Modifier.weight(1f)) {
                            StoreRow(store, isSaved = false) { onOpenStore(store) }
                        }
                        IconButton(onClick = { scope.launch { favoritesStore.remove(store) } }) {
                            Icon(Icons.Filled.Delete, contentDescription = "Remove $store from saved stores")
                        }
                    }
                }
                Footnote(
                    if (favoritesStore.isSyncedToAccount) {
                        "Synced to your Caramel account."
                    } else {
                        "Saved on this device. Sign in from the Account tab to keep them across devices."
                    },
                )
            }
        }
    }
}
