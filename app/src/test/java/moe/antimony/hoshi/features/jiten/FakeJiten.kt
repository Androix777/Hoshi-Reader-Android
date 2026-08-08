package moe.antimony.hoshi.features.jiten

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow

class FakeJitenSettingsRepository(
    initial: JitenSettings = JitenSettings(enabled = true, apiKey = "test-key"),
) : JitenSettingsRepository {
    private val state = MutableStateFlow(initial)

    override val settings: Flow<JitenSettings> = state

    override suspend fun update(transform: (JitenSettings) -> JitenSettings) {
        state.value = transform(state.value)
    }
}

data class RecordedJitenRequest(
    val url: String,
    val apiKey: String,
    val body: String?,
)

/**
 * Replays [responses] in order, repeating the last one once exhausted, and
 * records every attempt so retry behaviour is observable.
 */
class FakeJitenTransport(
    private val responses: List<Result<JitenHttpResponse>>,
) : JitenHttpTransport {
    constructor(vararg responses: JitenHttpResponse) : this(responses.map { Result.success(it) })

    val requests = mutableListOf<RecordedJitenRequest>()

    override fun post(url: String, apiKey: String, body: String?, timeoutMillis: Int): JitenHttpResponse {
        requests += RecordedJitenRequest(url = url, apiKey = apiKey, body = body)
        val response = responses.getOrElse(requests.size - 1) { responses.last() }
        return response.getOrElse { error -> throw error }
    }

    companion object {
        fun ok(body: String) = JitenHttpResponse(statusCode = 200, body = body)
        fun status(code: Int, body: String = "") = JitenHttpResponse(statusCode = code, body = body)
        fun unreachable(): Result<JitenHttpResponse> = Result.failure(IOException("offline"))
    }
}

fun jitenApiClient(
    transport: JitenHttpTransport,
    settingsRepository: JitenSettingsRepository = FakeJitenSettingsRepository(),
): JitenApiClient =
    JitenApiClient(
        settingsRepository = settingsRepository,
        transport = transport,
        retryDelay = { },
        ioDispatcher = Dispatchers.Unconfined,
    )
