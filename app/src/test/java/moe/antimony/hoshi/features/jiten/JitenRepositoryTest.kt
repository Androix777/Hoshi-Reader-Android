package moe.antimony.hoshi.features.jiten

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class JitenRepositoryTest {
    @Test
    fun disabledJitenParsesNothing() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok(TwoParagraphResponse))
        val repository = jitenRepository(
            transport,
            FakeJitenSettingsRepository(JitenSettings(enabled = false, apiKey = "test-key")),
        )

        assertTrue(repository.parseChapter(listOf("時間がある")).isEmpty())
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun missingApiKeyParsesNothing() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok(TwoParagraphResponse))
        val repository = jitenRepository(
            transport,
            FakeJitenSettingsRepository(JitenSettings(enabled = true, apiKey = "")),
        )

        assertTrue(repository.parseChapter(listOf("時間がある")).isEmpty())
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun paragraphsWithoutJapaneseAreNeverPosted() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok(TwoParagraphResponse))
        val repository = jitenRepository(transport)

        repository.parseChapter(listOf("Chapter 1", "時間がある", "— 42 —"))

        assertEquals(listOf("時間がある"), transport.postedParagraphs().single())
    }

    @Test
    fun skippedParagraphsKeepTheirPlaceInTheResult() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok(TwoParagraphResponse))
        val repository = jitenRepository(transport)

        val tokens = repository.parseChapter(listOf("Chapter 1", "時間がある", "海が見えた"))

        // A shifted result would colour the wrong paragraph entirely.
        assertEquals(3, tokens.size)
        assertTrue(tokens[0].isEmpty())
        assertEquals("時間", tokens[1].single().card.spelling)
        assertEquals("海", tokens[2].single().card.spelling)
    }

    @Test
    fun aChapterTooLargeForOneRequestIsSplit() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok(TwoParagraphResponse))
        val repository = jitenRepository(transport)
        val paragraphs = List(4) { "時".repeat(1_000) }

        repository.parseChapter(paragraphs)

        val posted = transport.postedParagraphs()
        assertEquals(2, posted.size)
        assertEquals(4, posted.sumOf { it.size })
    }

    @Test
    fun aParagraphOverTheRequestLimitTravelsAlone() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok(TwoParagraphResponse))
        val repository = jitenRepository(transport)

        // Splitting it would renumber the offsets against text never posted.
        repository.parseChapter(listOf("時".repeat(5_000), "海が見えた"))

        val posted = transport.postedParagraphs()
        assertEquals(2, posted.size)
        assertEquals(1, posted[0].size)
    }

    @Test
    fun aFailedChunkFailsTheWholeChapter() {
        val transport = FakeJitenTransport(FakeJitenTransport.status(500))
        val repository = jitenRepository(transport)

        val error = assertThrows(JitenApiException::class.java) {
            runBlocking { repository.parseChapter(listOf("時間がある")) }
        }

        assertEquals(JitenFailure.Server, error.failure)
    }

    @Test
    fun readerTokensCarryOffsetsAndStatesUnchanged() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok(TwoParagraphResponse))
        val repository = jitenRepository(transport)

        val tokens = repository.parseChapter(listOf("時間がある")).toReaderTokens()

        val token = tokens.single().single()
        assertEquals(0, token.start)
        assertEquals(2, token.end)
        assertEquals(1, token.wordId)
        assertEquals(listOf("young"), token.states)
    }

    private fun jitenRepository(
        transport: JitenHttpTransport,
        settingsRepository: JitenSettingsRepository = FakeJitenSettingsRepository(),
    ) = JitenRepository(
        apiClient = jitenApiClient(transport, settingsRepository),
        settingsRepository = settingsRepository,
    )

    private fun FakeJitenTransport.postedParagraphs(): List<List<String>> =
        requests.map { request ->
            val body = Json.parseToJsonElement(request.body!!) as JsonObject
            body.getValue("text").jsonArray.map { it.jsonPrimitive.content }
        }

    private companion object {
        /** Enough entries that a one-paragraph request also finds a match at index 0. */
        const val TwoParagraphResponse = """
            {
              "tokens": [
                [{"wordId": 1, "readingIndex": 0, "start": 0, "end": 2}],
                [{"wordId": 2, "readingIndex": 0, "start": 0, "end": 1}]
              ],
              "vocabulary": [
                {"wordId": 1, "readingIndex": 0, "spelling": "時間", "knownState": [1]},
                {"wordId": 2, "readingIndex": 0, "spelling": "海", "knownState": [0]}
              ]
            }
        """
    }
}
