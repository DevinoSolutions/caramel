package com.devino.caramel.core

/** The state of one network-backed screen section (iOS `LoadState`). */
sealed interface LoadState<out T> {
    data object Idle : LoadState<Nothing>

    data object Loading : LoadState<Nothing>

    data class Loaded<T>(val value: T) : LoadState<T>

    data class Failed(val message: String) : LoadState<Nothing>
}

/**
 * Runs one API call and maps the outcome to a [LoadState]: a failure is shown (with its request
 * id), never swallowed. Cancellation is not an [ApiError] and propagates to the caller.
 */
suspend fun <T> loadState(block: suspend () -> T): LoadState<T> = try {
    LoadState.Loaded(block())
} catch (e: ApiError) {
    LoadState.Failed(e.message ?: "Request failed")
}
