package com.devino.caramel.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Persistent string lists (SharedPreferences in production). */
interface ListStore {
    fun read(key: String): List<String>

    fun write(key: String, values: List<String>)
}

data class FavoritesState(val stores: List<String> = emptyList(), val errorMessage: String? = null)

/**
 * Saved stores. Signed out they are a local list; signed in, the account's /api/account/favorites
 * list is the truth plus any store still waiting to be pushed up, and the local list mirrors that
 * union. Port of apps/caramel-apple FavoritesStore.swift.
 *
 * A store saved on this device is never dropped by a sync: it stays in the persisted "pending
 * push" set until the server has confirmed it.
 */
class FavoritesStore(
    private val api: CaramelApi,
    private val lists: ListStore,
    private val tokenProvider: () -> String?,
) {
    private val mutableState = MutableStateFlow(FavoritesState(stores = lists.read(SAVED_KEY)))
    val state: StateFlow<FavoritesState> = mutableState.asStateFlow()

    val isSyncedToAccount: Boolean get() = tokenProvider() != null

    fun contains(domain: String): Boolean = mutableState.value.stores.contains(key(domain))

    fun dismissError() {
        mutableState.update { it.copy(errorMessage = null) }
    }

    /** Signed in: retries any pending pushes, then adopts the account list plus whatever could not be pushed. */
    suspend fun refresh() {
        val token = tokenProvider() ?: return
        sync(token)
    }

    suspend fun toggle(domain: String) {
        set(domain, favorited = !contains(domain))
    }

    suspend fun remove(domain: String) {
        set(domain, favorited = false)
    }

    /**
     * Called when the session changes: a new sign-in queues the device list for push and merges it
     * with the account list; a sign-out drops the account's list (and the queue) from the device.
     */
    suspend fun sessionChanged() {
        val token = tokenProvider()
        if (token == null) {
            setPending(emptyList())
            replace(emptyList())
            return
        }
        setPending((pending() + mutableState.value.stores).distinct().sorted())
        sync(token)
    }

    private suspend fun sync(token: String) {
        val serverStores = try {
            api.favorites(token)
        } catch (e: ApiError) {
            // Nothing is dropped: the cached list and the pending queue stay as they were.
            mutableState.update { it.copy(errorMessage = e.message) }
            return
        }

        val pushedKeys = mutableListOf<String>()
        val serverSet = serverStores.toSet()
        var stillPending = pending().filter { it !in serverSet }
        val failures = mutableListOf<String>()
        var pushed = 0
        var stoppedOnRateLimit = false

        for (domain in stillPending.toList()) {
            if (pushed >= MAX_PUSHES_PER_SYNC) break
            try {
                val stored = api.setFavorite(domain, favorited = true, bearer = token)
                pushed += 1
                pushedKeys += stored
                stillPending = stillPending.filter { it != domain && it != stored }
            } catch (e: ApiError) {
                if (e.isRateLimited) {
                    stoppedOnRateLimit = true
                    break
                }
                pushed += 1
                failures += "$domain: ${e.message}"
            }
        }

        setPending(stillPending)
        // Server list first (its order), then what was just pushed, then what is still waiting.
        replace((serverStores + pushedKeys + stillPending).distinct())

        val waiting = stillPending.size
        val waitingText = "$waiting saved ${if (waiting == 1) "store" else "stores"} will sync to your account the next time the app refreshes."
        val message = when {
            stoppedOnRateLimit -> "Too many changes at once. $waitingText"
            failures.isNotEmpty() -> "Could not move some saved stores to your account:\n" + failures.joinToString("\n")
            waiting > 0 -> waitingText
            else -> null
        }
        if (message != null) mutableState.update { it.copy(errorMessage = message) }
    }

    private suspend fun set(domain: String, favorited: Boolean) {
        val key = key(domain)
        val token = tokenProvider()
        val current = mutableState.value.stores
        if (token == null) {
            replace(if (favorited) listOf(key) + current.filter { it != key } else current.filter { it != key })
            return
        }
        try {
            val stored = api.setFavorite(key, favorited, token)
            setPending(pending().filter { it != key && it != stored })
            val latest = mutableState.value.stores
            replace(
                if (favorited) listOf(stored) + latest.filter { it != stored && it != key }
                else latest.filter { it != stored && it != key },
            )
        } catch (e: ApiError) {
            mutableState.update { it.copy(errorMessage = e.message) }
        }
    }

    private fun pending(): List<String> = lists.read(PENDING_KEY)

    private fun setPending(domains: List<String>) = lists.write(PENDING_KEY, domains)

    private fun replace(newStores: List<String>) {
        mutableState.update { it.copy(stores = newStores) }
        lists.write(SAVED_KEY, newStores)
    }

    companion object {
        const val SAVED_KEY = "saved_stores"
        const val PENDING_KEY = "saved_stores_pending_push"

        /**
         * TODO(T-7474): the server allows 30 mutations/min per account (same limit as the iOS app,
         * T-4905). One sync pushes at most this many stores, sequentially, stopping on HTTP 429; the
         * rest stay pending and go up on the next sync. A bulk endpoint would remove the cap.
         */
        private const val MAX_PUSHES_PER_SYNC = 25

        fun key(domain: String): String = domain.trim().lowercase()
    }
}
