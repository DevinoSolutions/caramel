package com.devino.caramel

import com.devino.caramel.core.CaramelApi
import com.devino.caramel.core.HttpRequest
import com.devino.caramel.core.HttpResponse
import com.devino.caramel.core.HttpTransport
import com.devino.caramel.core.TokenStore

/** Scripted transport: [handler] answers each request; every request is recorded. */
class FakeTransport(private val handler: (HttpRequest) -> HttpResponse) : HttpTransport {
    val requests = mutableListOf<HttpRequest>()

    override suspend fun execute(request: HttpRequest): HttpResponse {
        requests += request
        return handler(request)
    }
}

fun ok(body: String) = HttpResponse(200, body)

fun testApi(handler: (HttpRequest) -> HttpResponse): Pair<CaramelApi, FakeTransport> {
    val transport = FakeTransport(handler)
    var counter = 0
    return CaramelApi("https://example.test", transport) { "req-${++counter}" } to transport
}

class MemoryTokenStore(var token: String? = null) : TokenStore {
    override fun read(): String? = token

    override fun write(token: String) {
        this.token = token
    }

    override fun delete() {
        token = null
    }
}
