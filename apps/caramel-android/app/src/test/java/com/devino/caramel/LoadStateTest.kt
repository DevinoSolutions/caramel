package com.devino.caramel

import com.devino.caramel.core.ApiError
import com.devino.caramel.core.LoadState
import com.devino.caramel.core.loadState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class LoadStateTest {
    @Test
    fun successIsLoaded() = runBlocking {
        assertEquals(LoadState.Loaded(3), loadState { 3 })
    }

    @Test
    fun apiErrorIsFailedWithItsMessage() = runBlocking {
        val state = loadState<Int> { throw ApiError("GET", "/x", 500, "r1", "down") }
        assertEquals(LoadState.Failed("GET /x failed (HTTP 500): down [request r1]"), state)
    }

    @Test
    fun cancellationPropagates() {
        assertThrows(CancellationException::class.java) { runBlocking { loadState<Int> { throw CancellationException("stop") } } }
    }
}
