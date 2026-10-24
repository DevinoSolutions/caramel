package com.devino.caramel.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.foundation.layout.RowScope
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.devino.caramel.core.LoadState

/** A visible failure with a retry, used wherever a request can fail. */
@Composable
fun ErrorBanner(message: String, modifier: Modifier = Modifier, retryTitle: String = "Try again", onRetry: () -> Unit) {
    Column(modifier = modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Something went wrong", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.error)
        Text(message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedButton(onClick = onRetry) { Text(retryTitle) }
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier.fillMaxWidth().padding(top = 16.dp, bottom = 4.dp),
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
    )
}

@Composable
fun Hint(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier = modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
fun Footnote(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier = modifier.padding(vertical = 4.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** One store in a list: its domain, a link to its codes, a saved marker. */
@Composable
fun StoreRow(domain: String, isSaved: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(Icons.Filled.ShoppingCart, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Text(domain, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
        if (isSaved) {
            Icon(Icons.Filled.Favorite, contentDescription = "Saved", tint = MaterialTheme.colorScheme.primary)
        }
    }
}

/** The spinner / error / content switch every network-backed section shares. */
@Composable
fun <T> LoadStateContent(state: LoadState<T>, onRetry: () -> Unit, content: @Composable (T) -> Unit) {
    when (state) {
        LoadState.Idle, LoadState.Loading -> CircularProgressIndicator(modifier = Modifier.padding(16.dp))
        is LoadState.Failed -> ErrorBanner(state.message, onRetry = onRetry)
        is LoadState.Loaded -> content(state.value)
    }
}

@Composable
fun CodeChip(code: String) {
    Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)) {
        Text(
            code,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            style = MaterialTheme.typography.bodyLarge.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
        )
    }
}

/**
 * A screen with a title bar. The app-level Scaffold (CaramelApp) already applies the system-bar
 * insets, so the inner one must not apply them a second time.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenScaffold(
    title: String,
    navigationIcon: @Composable () -> Unit = {},
    actions: @Composable RowScope.() -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(title = { Text(title) }, navigationIcon = navigationIcon, actions = actions, windowInsets = WindowInsets(0))
        },
        contentWindowInsets = WindowInsets(0),
        content = content,
    )
}
