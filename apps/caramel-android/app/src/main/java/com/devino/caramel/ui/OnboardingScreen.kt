package com.devino.caramel.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.unit.dp
import com.devino.caramel.core.AppConfig

/**
 * The Get started tab. The iOS twin walks the shopper through turning the Safari extension on; the
 * Android app has no extension to turn on, so this screen only says what the app does.
 *
 * Copy is intentionally limited to what the app's own tabs do (no new marketing claims).
 */
object OnboardingCopy {
    const val INTRO = "Caramel finds coupon codes for the stores you shop at."
    val STEPS = listOf(
        "Deals shows codes that recently worked for other shoppers, and the top stores.",
        "Search finds a store by name or domain and lists its codes. Tap a code to copy it.",
        "Saved keeps the stores you care about. Sign in from Account to keep them across devices.",
    )
}

@Composable
fun OnboardingScreen() {
    val uriHandler = LocalUriHandler.current
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Get started", style = MaterialTheme.typography.headlineMedium)
        Text(OnboardingCopy.INTRO, style = MaterialTheme.typography.bodyLarge)
        OnboardingCopy.STEPS.forEachIndexed { index, text ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primary, modifier = Modifier.size(26.dp)) {
                    Text(
                        "${index + 1}",
                        color = MaterialTheme.colorScheme.onPrimary,
                        style = MaterialTheme.typography.labelLarge,
                        modifier = Modifier.padding(horizontal = 9.dp, vertical = 3.dp),
                    )
                }
                Text(text, style = MaterialTheme.typography.bodyLarge)
            }
        }
        Spacer(Modifier.height(8.dp))
        Button(onClick = { uriHandler.openUri(AppConfig.WEBSITE_URL) }) { Text("Open grabcaramel.com") }
    }
}
