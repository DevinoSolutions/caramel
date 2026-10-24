package com.devino.caramel.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.devino.caramel.AppContainer

private enum class Tab(val route: String, val label: String, val icon: ImageVector) {
    ONBOARDING("onboarding", "Get started", Icons.Filled.CheckCircle),
    DEALS("deals", "Deals", Icons.Filled.Home),
    SEARCH("search", "Search", Icons.Filled.Search),
    SAVED("saved", "Saved", Icons.Filled.Favorite),
    ACCOUNT("account", "Account", Icons.Filled.Person),
}

private const val STORE_ROUTE = "store"
private const val STORE_ARG = "domain"

/**
 * The app shell: five tabs and the store page. State holders (session, saved stores) are created
 * once in [AppContainer] and passed down.
 */
@Composable
fun CaramelApp(container: AppContainer, onStartSignIn: (String) -> Unit) {
    val navController = rememberNavController()
    val session by container.session.state.collectAsStateWithLifecycle()
    val favorites by container.favorites.state.collectAsStateWithLifecycle()

    // Launch: confirm the stored sign-in is alive, then adopt the account's saved stores.
    LaunchedEffect(Unit) {
        container.session.validate()
        container.favorites.refresh()
    }
    // A sign-in or sign-out queues / drops the account's saved stores. Not run for the token the app launched with.
    var lastToken by remember { mutableStateOf(session.token) }
    LaunchedEffect(session.token) {
        if (session.token != lastToken) {
            lastToken = session.token
            container.favorites.sessionChanged()
        }
    }

    val backStackEntry by navController.currentBackStackEntryAsState()
    val route = backStackEntry?.destination?.route
    val openStore: (String) -> Unit = { domain -> navController.navigate("$STORE_ROUTE/$domain") }

    Scaffold(
        bottomBar = {
            if (Tab.entries.any { it.route == route }) {
                NavigationBar {
                    Tab.entries.forEach { tab ->
                        NavigationBarItem(
                            selected = route == tab.route,
                            onClick = {
                                navController.navigate(tab.route) {
                                    popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            icon = { Icon(tab.icon, contentDescription = null) },
                            label = { Text(tab.label) },
                        )
                    }
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = Tab.ONBOARDING.route,
            modifier = Modifier.padding(padding),
        ) {
            composable(Tab.ONBOARDING.route) { OnboardingScreen() }
            composable(Tab.DEALS.route) { DealsScreen(container.api, favorites.stores, openStore) }
            composable(Tab.SEARCH.route) { SearchScreen(container.api, favorites.stores, openStore) }
            composable(Tab.SAVED.route) { SavedScreen(container.favorites, favorites, openStore) }
            composable(Tab.ACCOUNT.route) { AccountScreen(container, session, onStartSignIn) }
            composable(
                route = "$STORE_ROUTE/{$STORE_ARG}",
                arguments = listOf(navArgument(STORE_ARG) { type = NavType.StringType }),
            ) { entry ->
                val domain = checkNotNull(entry.arguments?.getString(STORE_ARG)) { "store route without a domain" }
                StoreDetailScreen(domain, container.api, container.favorites, favorites.stores, onBack = { navController.popBackStack() })
            }
        }
    }
}
