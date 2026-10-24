package com.devino.caramel.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.devino.caramel.core.CaramelApi
import com.devino.caramel.core.LoadState
import com.devino.caramel.core.RecentlyWorkedCoupon
import com.devino.caramel.core.Timestamps
import com.devino.caramel.core.loadState
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.async

/** The Deals tab: codes that recently worked for shoppers, and the top stores. */
@Composable
fun DealsScreen(api: CaramelApi, savedStores: List<String>, onOpenStore: (String) -> Unit) {
    var worked by remember { mutableStateOf<LoadState<List<RecentlyWorkedCoupon>>>(LoadState.Idle) }
    var topStores by remember { mutableStateOf<LoadState<List<String>>>(LoadState.Idle) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        worked = LoadState.Loading
        topStores = LoadState.Loading
        coroutineScope {
            val a = async { worked = loadState { api.recentlyWorked() } }
            val b = async { topStores = loadState { api.topStores() } }
            a.await()
            b.await()
        }
    }

    ScreenScaffold(
        title = "Deals",
        actions = { IconButton(onClick = { reload += 1 }) { Icon(Icons.Filled.Refresh, contentDescription = "Refresh") } },
    ) { padding ->
        Column(
            modifier = Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
        ) {
            SectionTitle("Codes that just worked")
            LoadStateContent(worked, onRetry = { reload += 1 }) { coupons ->
                if (coupons.isEmpty()) {
                    Hint("No codes have been confirmed in the last day. Check back soon.")
                } else {
                    coupons.forEach { coupon -> WorkedRow(coupon) { onOpenStore(coupon.storeDomain) } }
                }
            }
            SectionTitle("Top stores")
            LoadStateContent(topStores, onRetry = { reload += 1 }) { stores ->
                stores.forEach { store -> StoreRow(store, isSaved = store in savedStores) { onOpenStore(store) } }
            }
        }
    }
}

@Composable
private fun WorkedRow(coupon: RecentlyWorkedCoupon, onClick: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(coupon.storeDomain, style = MaterialTheme.typography.titleMedium)
        Text(coupon.title, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(coupon.code, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold))
            coupon.discountLabel?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
            Timestamps.relative(coupon.lastWorkedAt)?.let {
                Text("worked $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
