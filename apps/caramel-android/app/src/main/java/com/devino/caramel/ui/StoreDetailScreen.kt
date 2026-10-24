package com.devino.caramel.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.devino.caramel.core.CaramelApi
import com.devino.caramel.core.Coupon
import com.devino.caramel.core.CouponsPage
import com.devino.caramel.core.FavoritesStore
import com.devino.caramel.core.LoadState
import com.devino.caramel.core.Timestamps
import com.devino.caramel.core.loadState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** One store's codes, with copy-code and a save (heart) button. */
@Composable
fun StoreDetailScreen(
    domain: String,
    api: CaramelApi,
    favoritesStore: FavoritesStore,
    savedStores: List<String>,
    onBack: () -> Unit,
) {
    var state by remember { mutableStateOf<LoadState<CouponsPage>>(LoadState.Idle) }
    var reload by remember { mutableIntStateOf(0) }
    var copiedId by remember { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val isSaved = FavoritesStore.key(domain) in savedStores

    LaunchedEffect(domain, reload) {
        state = LoadState.Loading
        state = loadState { api.coupons(site = domain) }
    }
    LaunchedEffect(copiedId) {
        val shown = copiedId ?: return@LaunchedEffect
        delay(2_000)
        if (copiedId == shown) copiedId = null
    }

    ScreenScaffold(
        title = domain,
        navigationIcon = {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
        },
        actions = {
            IconButton(onClick = { scope.launch { favoritesStore.toggle(domain) } }) {
                Icon(
                    if (isSaved) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,
                    contentDescription = if (isSaved) "Remove from saved stores" else "Save store",
                )
            }
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            LoadStateContent(state, onRetry = { reload += 1 }) { page ->
                if (page.coupons.isEmpty()) {
                    Hint("No codes for $domain right now.")
                } else {
                    SectionTitle("${page.total} ${if (page.total == 1) "code" else "codes"}")
                    page.coupons.forEach { coupon ->
                        CouponRow(coupon, isCopied = copiedId == coupon.id) {
                            copyToClipboard(context, coupon.code)
                            copiedId = coupon.id
                        }
                    }
                    // TODO(T-7474): only page 1 (50 codes) is loaded; `hasMore` just points to the
                    // website (iOS has the same limit, T-4905). CaramelApi.coupons already takes `page`.
                    if (page.hasMore) {
                        Footnote("Showing the first ${page.coupons.size}. Open grabcaramel.com for the full list.")
                    }
                }
            }
        }
    }
}

private fun copyToClipboard(context: Context, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("Coupon code", text))
}

@Composable
private fun CouponRow(coupon: Coupon, isCopied: Boolean, onCopy: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(coupon.title, modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, maxLines = 2)
            coupon.discountLabel?.let {
                Text(it, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
            }
        }
        if (coupon.description.isNotEmpty()) {
            Text(
                coupon.description,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 3,
            )
        }
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            CodeChip(coupon.code)
            Row(modifier = Modifier.weight(1f)) {}
            OutlinedButton(onClick = onCopy) { Text(if (isCopied) "Copied" else "Copy") }
        }
        val notes = buildList {
            coupon.lastWorkedAt?.let { Timestamps.relative(it) }?.let { add("Worked $it") }
            if (coupon.keepsFailing == true) add("Often fails")
            if (coupon.newCustomersOnly == true) add("New customers only")
            if (coupon.expired) add("Expired")
        }
        if (notes.isNotEmpty()) Footnote(notes.joinToString("  "))
    }
}
