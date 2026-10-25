package com.devino.caramel.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** A visible failure with an action, used wherever the shell can fail (page load, sign-in, a refused link). */
@Composable
fun ErrorBanner(message: String, modifier: Modifier = Modifier, retryTitle: String = "Try again", onRetry: () -> Unit) {
    Column(modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Something went wrong", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.error)
        Text(message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedButton(onClick = onRetry) { Text(retryTitle) }
    }
}
