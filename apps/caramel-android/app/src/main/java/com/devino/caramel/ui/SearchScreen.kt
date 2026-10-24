package com.devino.caramel.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.devino.caramel.core.CaramelApi
import com.devino.caramel.core.LoadState
import com.devino.caramel.core.loadState
import kotlinx.coroutines.delay

private const val DEBOUNCE_MS = 300L

/** Store search and browse. An empty query lists popular stores. */
@Composable
fun SearchScreen(api: CaramelApi, savedStores: List<String>, onOpenStore: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var state by remember { mutableStateOf<LoadState<List<String>>>(LoadState.Idle) }
    var reload by remember { mutableIntStateOf(0) }

    // Re-runs on every keystroke and cancels the previous run, so the delay debounces typing.
    LaunchedEffect(query, reload) {
        delay(DEBOUNCE_MS)
        state = LoadState.Loading
        state = loadState { api.storeOptions(query.trim()) }
    }

    ScreenScaffold(title = "Search") { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize().padding(horizontal = 16.dp)) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                label = { Text("Store name or domain") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Uri,
                ),
            )
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                LoadStateContent(state, onRetry = { reload += 1 }) { stores ->
                    if (stores.isEmpty()) {
                        Hint("No stores match \"${query.trim()}\". Try the store's domain, like nike.com.")
                    } else {
                        stores.forEach { store -> StoreRow(store, isSaved = store in savedStores) { onOpenStore(store) } }
                    }
                }
            }
        }
    }
}
