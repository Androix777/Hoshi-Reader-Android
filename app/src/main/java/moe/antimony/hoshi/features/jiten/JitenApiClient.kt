package moe.antimony.hoshi.features.jiten

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.random.Random
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import moe.antimony.hoshi.di.IoDispatcher

data class JitenHttpResponse(
    val statusCode: Int,
    val body: String,
)

fun interface JitenHttpTransport {
    /** Performs a blocking POST. Callers move it off the main thread. */
    fun post(url: String, apiKey: String, body: String?, timeoutMillis: Int): JitenHttpResponse
}

class HttpJitenTransport @Inject constructor() : JitenHttpTransport {
    override fun post(url: String, apiKey: String, body: String?, timeoutMillis: Int): JitenHttpResponse {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = timeoutMillis
            readTimeout = timeoutMillis
            doOutput = body != null
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Authorization", "ApiKey $apiKey")
        }
        return try {
            if (body != null) {
                connection.outputStream.use { output -> output.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            JitenHttpResponse(statusCode = status, body = text)
        } finally {
            connection.disconnect()
        }
    }
}

/**
 * Waits between retry attempts. Separated so tests exercise the retry policy
 * without really sleeping.
 */
fun interface JitenRetryDelay {
    suspend fun await(attempt: Int)
}

class ExponentialJitenRetryDelay @Inject constructor() : JitenRetryDelay {
    override suspend fun await(attempt: Int) {
        val base = InitialBackoffMillis shl attempt
        delay(base + Random.nextLong(base / 2 + 1))
    }

    private companion object {
        const val InitialBackoffMillis = 500L
    }
}

enum class JitenFailure {
    /** No API key configured yet. */
    NotConfigured,

    /** The server rejected the key with 401/403. */
    Unauthorized,

    /** Transport failed, or every retry was exhausted. */
    Unreachable,

    /** The server answered but reported an error, or the payload was unusable. */
    Server,
}

class JitenApiException(
    val failure: JitenFailure,
    override val message: String,
    override val cause: Throwable? = null,
    /** HTTP status behind a [JitenFailure.Server] failure, when there was one. */
    val statusCode: Int? = null,
) : RuntimeException(message, cause)

/**
 * Talks to the Jiten reader API.
 *
 * The client owns retries, the auth header and the rejected-key latch; callers
 * get either a decoded result or a [JitenApiException]. Nothing here knows about
 * the reader DOM or about offsets.
 */
@Singleton
class JitenApiClient @Inject constructor(
    private val settingsRepository: JitenSettingsRepository,
    private val transport: JitenHttpTransport,
    private val retryDelay: JitenRetryDelay,
    @param:IoDispatcher private val ioDispatcher: CoroutineDispatcher,
) {
    /**
     * The key the server last rejected. While the configured key still equals it,
     * requests fail immediately instead of hammering the API with a known-bad key.
     */
    @Volatile
    private var rejectedApiKey: String? = null

    suspend fun ping(apiKey: String? = null) {
        request(
            action = "reader/ping",
            body = null,
            explicitApiKey = apiKey,
        )
    }

    suspend fun parse(paragraphs: List<String>): JitenParseResult {
        if (paragraphs.isEmpty()) return JitenParseResult(paragraphs = emptyList())
        val response = request(
            action = "reader/parse",
            body = json.encodeToString(JitenWire.ParseRequest(text = paragraphs)),
        )
        return decode<JitenWire.ParseResponse>(response).toParseResult()
    }

    /**
     * Refreshes card states without re-parsing text, for cached chapters and for
     * reconciling after a review.
     */
    suspend fun lookupVocabulary(words: List<JitenWordKey>): Map<JitenWordKey, List<JitenCardState>> {
        if (words.isEmpty()) return emptyMap()
        val response = request(
            action = "reader/lookup-vocabulary",
            body = json.encodeToString(
                JitenWire.LookupVocabularyRequest(words = words.map { listOf(it.wordId, it.readingIndex) }),
            ),
        )
        val decoded = decode<JitenWire.LookupVocabularyResponse>(response)
        return words.withIndex().associate { (index, key) ->
            key to decoded.result.getOrElse(index) { emptyList() }.toCardStates(fallback = JitenCardState.New)
        }
    }

    suspend fun review(key: JitenWordKey, rating: JitenRating) {
        request(
            action = "srs/review",
            body = json.encodeToString(
                JitenWire.ReviewRequest(
                    wordId = key.wordId,
                    readingIndex = key.readingIndex,
                    rating = rating.wireValue,
                ),
            ),
        )
    }

    suspend fun setVocabularyState(key: JitenWordKey, action: JitenDeckAction) {
        request(
            action = "srs/set-vocabulary-state",
            body = json.encodeToString(
                JitenWire.SetVocabularyStateRequest(
                    wordId = key.wordId,
                    readingIndex = key.readingIndex,
                    state = action.wireValue,
                ),
            ),
        )
    }

    suspend fun readerStudyDecks(): List<JitenStudyDeck> {
        val response = request(action = "srs/reader-study-decks", body = null)
        return decode<List<JitenWire.StudyDeck>>(response).map { deck ->
            JitenStudyDeck(
                id = deck.userStudyDeckId,
                name = deck.name,
                type = JitenStudyDeckType.fromWireValue(deck.deckType),
            )
        }
    }

    /**
     * @param explicitApiKey bypasses the rejected-key latch so the settings test
     * action can actually re-consult the server with a freshly typed key.
     */
    private suspend fun request(
        action: String,
        body: String?,
        explicitApiKey: String? = null,
    ): String {
        val apiKey = explicitApiKey?.takeIf { it.isNotBlank() }
            ?: settingsRepository.settings.first().apiKey.takeIf { it.isNotBlank() }
            ?: throw JitenApiException(JitenFailure.NotConfigured, "Jiten API key is not set")

        if (explicitApiKey == null && apiKey == rejectedApiKey) {
            throw JitenApiException(JitenFailure.Unauthorized, ApiKeyRejectedMessage)
        }

        val url = "$Endpoint/$action"
        var lastError: Throwable? = null

        repeat(MaxAttempts) { attempt ->
            val response = try {
                withContext(ioDispatcher) { transport.post(url, apiKey, body, TimeoutMillis) }
            } catch (error: IOException) {
                lastError = error
                if (attempt < MaxAttempts - 1) {
                    retryDelay.await(attempt)
                    return@repeat
                }
                throw JitenApiException(JitenFailure.Unreachable, "jiten.moe is unreachable", error)
            }

            if (response.statusCode == 401 || response.statusCode == 403) {
                rejectedApiKey = apiKey
                throw JitenApiException(JitenFailure.Unauthorized, ApiKeyRejectedMessage)
            }

            if (response.isRetryable && attempt < MaxAttempts - 1) {
                lastError = response.serverFailure()
                retryDelay.await(attempt)
                return@repeat
            }

            response.errorMessage()?.let { message ->
                throw JitenApiException(JitenFailure.Server, message, statusCode = response.statusCode)
            }

            if (response.statusCode !in 200..299) {
                throw response.serverFailure()
            }

            if (apiKey == rejectedApiKey) {
                rejectedApiKey = null
            }
            return response.body
        }

        throw lastError.asJitenApiException()
    }

    private inline fun <reified T> decode(body: String): T =
        runCatching { json.decodeFromString<T>(body) }
            .getOrElse { error ->
                throw JitenApiException(JitenFailure.Server, "Unexpected Jiten API response", error)
            }

    private val JitenHttpResponse.isRetryable: Boolean
        get() = statusCode == 429 || statusCode >= 500

    private fun JitenHttpResponse.serverFailure(): JitenApiException =
        JitenApiException(
            failure = JitenFailure.Server,
            message = "Jiten API returned $statusCode",
            statusCode = statusCode,
        )

    private fun JitenHttpResponse.errorMessage(): String? =
        body.takeIf { it.isNotBlank() && it.trimStart().startsWith('{') }
            ?.let { raw -> runCatching { json.decodeFromString<JitenWire.ErrorResponse>(raw) }.getOrNull() }
            ?.errorMessage
            ?.takeIf { it.isNotBlank() }

    private fun Throwable?.asJitenApiException(): JitenApiException = when (this) {
        is JitenApiException -> this
        null -> JitenApiException(JitenFailure.Unreachable, "jiten.moe is unreachable")
        else -> JitenApiException(JitenFailure.Unreachable, "jiten.moe is unreachable", this)
    }

    companion object {
        /**
         * The `/api` suffix is load-bearing. The extension's `requestByUrl` has a
         * suffix-less default parameter, but it is dead: every call goes through
         * `request.ts`, which passes the configured `jitenApiEndpoint`, and that
         * defaults to this value.
         */
        const val Endpoint = "https://api.jiten.moe/api"
        const val ApiKeyRejectedMessage =
            "Jiten rejected the API key. Update it in Settings."

        private const val TimeoutMillis = 30_000
        private const val MaxAttempts = 3

        private val json = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }
    }
}
