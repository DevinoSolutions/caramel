package com.devino.caramel.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** The orange accent the iOS container tints with (`.tint(.orange)`). */
val CaramelOrange = Color(0xFFE67E00)

private val LightColors = lightColorScheme(primary = CaramelOrange, secondary = CaramelOrange)
private val DarkColors = darkColorScheme(primary = Color(0xFFFFA43A), secondary = Color(0xFFFFA43A))

@Composable
fun CaramelTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors, content = content)
}
