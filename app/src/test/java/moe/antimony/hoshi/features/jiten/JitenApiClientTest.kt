package moe.antimony.hoshi.features.jiten

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class JitenApiClientTest {
    @Test
    fun pingPostsToReaderPingWithApiKeyHeader() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok("{}"))
        jitenApiClient(transport).ping()

        val request = transport.requests.single()
        assertEquals("${JitenApiClient.Endpoint}/reader/ping", request.url)
        assertEquals("test-key", request.apiKey)
        assertNull(request.body)
    }

    @Test
    fun endpointKeepsTheApiPathPrefix() {
        // Without /api every request 404s, which surfaces as an opaque server error.
        assertEquals("https://api.jiten.moe/api", JitenApiClient.Endpoint)
    }

    @Test
    fun serverFailuresCarryTheHttpStatusForDiagnostics() {
        val transport = FakeJitenTransport(FakeJitenTransport.status(404))
        val client = jitenApiClient(transport)

        val error = assertThrows(JitenApiException::class.java) { runBlocking { client.ping() } }

        assertEquals(JitenFailure.Server, error.failure)
        assertEquals(404, error.statusCode)
        assertEquals("404 must not be retried", 1, transport.requests.size)
    }

    @Test
    fun requestsFailWhenApiKeyIsNotConfigured() {
        val transport = FakeJitenTransport(FakeJitenTransport.ok("{}"))
        val client = jitenApiClient(
            transport = transport,
            settingsRepository = FakeJitenSettingsRepository(JitenSettings(enabled = true, apiKey = "")),
        )

        val error = assertThrows(JitenApiException::class.java) { runBlocking { client.ping() } }

        assertEquals(JitenFailure.NotConfigured, error.failure)
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun serverErrorsAreRetriedThenSucceed() = runBlocking {
        val transport = FakeJitenTransport(
            FakeJitenTransport.status(503),
            FakeJitenTransport.ok(SingleTokenParseResponse),
        )

        val result = jitenApiClient(transport).parse(listOf("時間"))

        assertEquals(2, transport.requests.size)
        assertEquals(1, result.paragraphs.single().size)
    }

    @Test
    fun rateLimitingIsRetriedUntilAttemptsAreExhausted() {
        val transport = FakeJitenTransport(FakeJitenTransport.status(429))
        val client = jitenApiClient(transport)

        val error = assertThrows(JitenApiException::class.java) { runBlocking { client.ping() } }

        assertEquals(JitenFailure.Server, error.failure)
        assertEquals(3, transport.requests.size)
    }

    @Test
    fun transportFailuresAreRetriedThenReportedAsUnreachable() {
        val transport = FakeJitenTransport(listOf(FakeJitenTransport.unreachable()))
        val client = jitenApiClient(transport)

        val error = assertThrows(JitenApiException::class.java) { runBlocking { client.ping() } }

        assertEquals(JitenFailure.Unreachable, error.failure)
        assertEquals(3, transport.requests.size)
    }

    @Test
    fun rejectedKeyIsNotRetriedAndLatchesLaterRequests() {
        val transport = FakeJitenTransport(FakeJitenTransport.status(401))
        val client = jitenApiClient(transport)

        val first = assertThrows(JitenApiException::class.java) { runBlocking { client.ping() } }
        val second = assertThrows(JitenApiException::class.java) { runBlocking { client.ping() } }

        assertEquals(JitenFailure.Unauthorized, first.failure)
        assertEquals(JitenFailure.Unauthorized, second.failure)
        assertEquals("the latched key must not reach the server again", 1, transport.requests.size)
    }

    @Test
    fun explicitApiKeyBypassesTheRejectedKeyLatch() = runBlocking {
        val transport = FakeJitenTransport(
            FakeJitenTransport.status(403),
            FakeJitenTransport.ok("{}"),
        )
        val client = jitenApiClient(transport)

        assertThrows(JitenApiException::class.java) { runBlocking { client.ping() } }
        client.ping(apiKey = "test-key")

        assertEquals(2, transport.requests.size)
    }

    @Test
    fun successAfterRevalidationClearsTheLatch() = runBlocking {
        val transport = FakeJitenTransport(
            FakeJitenTransport.status(401),
            FakeJitenTransport.ok("{}"),
            FakeJitenTransport.ok("{}"),
        )
        val client = jitenApiClient(transport)

        assertThrows(JitenApiException::class.java) { runBlocking { client.ping() } }
        client.ping(apiKey = "test-key")
        client.ping()

        assertEquals(3, transport.requests.size)
    }

    @Test
    fun errorMessagePayloadsAreSurfacedAsServerFailures() {
        val transport = FakeJitenTransport(
            FakeJitenTransport.ok("""{"error_message":"parse budget exceeded"}"""),
        )
        val client = jitenApiClient(transport)

        val error = assertThrows(JitenApiException::class.java) { runBlocking { client.parse(listOf("時間")) } }

        assertEquals(JitenFailure.Server, error.failure)
        assertEquals("parse budget exceeded", error.message)
    }

    @Test
    fun parseSkipsTheRequestWhenThereAreNoParagraphs() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok(SingleTokenParseResponse))

        val result = jitenApiClient(transport).parse(emptyList())

        assertTrue(result.paragraphs.isEmpty())
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun parsePostsParagraphsVerbatim() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok(SingleTokenParseResponse))

        jitenApiClient(transport).parse(listOf("時間がある", "  spaced  "))

        val body = Json.parseToJsonElement(transport.requests.single().body!!) as JsonObject
        val posted = body.getValue("text").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("時間がある", "  spaced  "), posted)
    }

    @Test
    fun lookupVocabularyMapsStatesBackToTheRequestedWords() = runBlocking {
        val transport = FakeJitenTransport(
            FakeJitenTransport.ok("""{"result":[[1,7],[]],"decks":[[3],[]]}"""),
        )
        val words = listOf(JitenWordKey(10, 0), JitenWordKey(11, 1))

        val states = jitenApiClient(transport).lookupVocabulary(words)

        assertEquals(listOf(JitenCardState.Young, JitenCardState.Suspended), states.getValue(words[0]))
        assertEquals(listOf(JitenCardState.New), states.getValue(words[1]))
    }

    @Test
    fun reviewSendsTheNumericRating() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok("{}"))

        jitenApiClient(transport).review(JitenWordKey(42, 1), JitenRating.Good)

        val request = transport.requests.single()
        assertEquals("${JitenApiClient.Endpoint}/srs/review", request.url)
        val body = Json.parseToJsonElement(request.body!!) as JsonObject
        assertEquals(42, body.getValue("wordId").jsonPrimitive.content.toInt())
        assertEquals(1, body.getValue("readingIndex").jsonPrimitive.content.toInt())
        assertEquals(3, body.getValue("rating").jsonPrimitive.content.toInt())
    }

    @Test
    fun setVocabularyStateSendsTheDeckActionName() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok("{}"))

        jitenApiClient(transport).setVocabularyState(JitenWordKey(42, 0), JitenDeckAction.BlacklistAdd)

        val request = transport.requests.single()
        assertEquals("${JitenApiClient.Endpoint}/srs/set-vocabulary-state", request.url)
        val body = Json.parseToJsonElement(request.body!!) as JsonObject
        // Not a card state: the endpoint takes a deck membership being changed.
        assertEquals("blacklist-add", body.getValue("state").jsonPrimitive.content)
    }

    @Test
    fun removingAMembershipIsItsOwnAction() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok("{}"))

        jitenApiClient(transport).setVocabularyState(JitenWordKey(42, 0), JitenDeckAction.NeverForgetRemove)

        val body = Json.parseToJsonElement(transport.requests.single().body!!) as JsonObject
        assertEquals("neverForget-remove", body.getValue("state").jsonPrimitive.content)
    }

    @Test
    fun studyDecksMapUnknownTypesToNull() = runBlocking {
        val transport = FakeJitenTransport(
            FakeJitenTransport.ok(
                """[{"userStudyDeckId":1,"name":"Mining","deckType":0},
                   |{"userStudyDeckId":2,"name":"Future","deckType":99}]""".trimMargin(),
            ),
        )

        val decks = jitenApiClient(transport).readerStudyDecks()

        assertEquals(JitenStudyDeckType.MediaDeck, decks[0].type)
        assertNull(decks[1].type)
    }

    @Test
    fun unusableResponsePayloadsBecomeServerFailures() {
        val transport = FakeJitenTransport(FakeJitenTransport.ok("not json"))
        val client = jitenApiClient(transport)

        val error = assertThrows(JitenApiException::class.java) { runBlocking { client.parse(listOf("時間")) } }

        assertEquals(JitenFailure.Server, error.failure)
    }

    private companion object {
        const val SingleTokenParseResponse = """
            {
              "tokens": [[{"wordId": 1, "readingIndex": 0, "start": 0, "end": 2}]],
              "vocabulary": [
                {
                  "wordId": 1,
                  "readingIndex": 0,
                  "spelling": "時間",
                  "reading": "時間[じかん]",
                  "knownState": [1]
                }
              ]
            }
        """
    }
}
