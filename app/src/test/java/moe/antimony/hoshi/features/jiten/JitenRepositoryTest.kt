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

    @Test
    fun parsingCachesTheCardsItSaw() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok(TwoParagraphResponse))
        val repository = jitenRepository(transport)

        repository.parseChapter(listOf("時間がある", "海が見えた"))

        // A tap answered from here is a tap that costs no request.
        assertEquals("時間", repository.card(JitenWordKey(wordId = 1, readingIndex = 0))?.spelling)
        assertEquals("海", repository.card(JitenWordKey(wordId = 2, readingIndex = 0))?.spelling)
        assertEquals(1, transport.requests.size)
    }

    @Test
    fun aWordThatWasNeverParsedIsNotCached() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok(TwoParagraphResponse))
        val repository = jitenRepository(transport)

        repository.parseChapter(listOf("時間がある"))

        assertNull(repository.card(JitenWordKey(wordId = 404, readingIndex = 0)))
        // A reading is part of the identity, so the other reading is a miss too.
        assertNull(repository.card(JitenWordKey(wordId = 1, readingIndex = 7)))
    }

    @Test
    fun rememberingACardReplacesTheStatesParsingLeftBehind() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok(TwoParagraphResponse))
        val repository = jitenRepository(transport)
        repository.parseChapter(listOf("時間がある"))
        val key = JitenWordKey(wordId = 1, readingIndex = 0)
        val reviewed = repository.card(key)!!.copy(states = listOf(JitenCardState.Mature))

        repository.rememberCards(listOf(reviewed))

        // Reviewing a word must not leave the popup showing its former state.
        assertEquals(listOf(JitenCardState.Mature), repository.card(key)?.states)
    }

    @Test
    fun gradingReviewsTheCardAndReportsTheStatesTheServerSettledOn() = runBlocking {
        val transport = FakeJitenTransport(
            FakeJitenTransport.ok(TwoParagraphResponse),
            FakeJitenTransport.ok("{}"),
            FakeJitenTransport.ok("""{"result": [[1]]}"""),
        )
        val repository = jitenRepository(transport)
        repository.parseChapter(listOf("時間がある"))
        val key = JitenWordKey(wordId = 1, readingIndex = 0)

        val states = repository.applyAction(key, JitenReaderAction.Good)

        assertTrue(transport.requests[1].url.endsWith("/srs/review"))
        // Read back, not predicted: where a grade lands is the server's rule.
        assertEquals(listOf(JitenCardState.Young), states)
        // And the cache is what the next tap reads, so it cannot keep the old.
        assertEquals(listOf(JitenCardState.Young), repository.card(key)?.states)
    }

    @Test
    fun neverForgetTogglesOffForACardThatAlreadyHasIt() = runBlocking {
        val transport = FakeJitenTransport(
            FakeJitenTransport.ok("{}"),
            FakeJitenTransport.ok("""{"result": [[2]]}"""),
        )
        val repository = jitenRepository(transport)
        val key = JitenWordKey(wordId = 5, readingIndex = 0)
        repository.rememberCards(listOf(cardWith(key, JitenCardState.Mastered)))

        repository.applyAction(key, JitenReaderAction.NeverForget)

        assertEquals("neverForget-remove", transport.requests[0].sentState())
    }

    @Test
    fun blacklistAddsForACardThatDoesNotHaveIt() = runBlocking {
        val transport = FakeJitenTransport(
            FakeJitenTransport.ok("{}"),
            FakeJitenTransport.ok("""{"result": [[3]]}"""),
        )
        val repository = jitenRepository(transport)
        val key = JitenWordKey(wordId = 5, readingIndex = 0)
        repository.rememberCards(listOf(cardWith(key, JitenCardState.New)))

        repository.applyAction(key, JitenReaderAction.Blacklist)

        assertEquals("blacklist-add", transport.requests[0].sentState())
    }

    @Test
    fun anUncachedCardIsTreatedAsNotAMemberRatherThanRefused() = runBlocking {
        val transport = FakeJitenTransport(
            FakeJitenTransport.ok("{}"),
            FakeJitenTransport.ok("""{"result": [[3]]}"""),
        )
        val repository = jitenRepository(transport)

        // Evicted, or the chapter was parsed in an earlier session. Adding twice
        // is harmless; doing nothing would strand the button.
        repository.applyAction(JitenWordKey(wordId = 5, readingIndex = 0), JitenReaderAction.Blacklist)

        assertEquals("blacklist-add", transport.requests[0].sentState())
    }

    @Test
    fun disabledJitenPerformsNoAction() = runBlocking {
        val transport = FakeJitenTransport(FakeJitenTransport.ok("{}"))
        val repository = jitenRepository(
            transport,
            FakeJitenSettingsRepository(JitenSettings(enabled = false, apiKey = "test-key")),
        )

        val states = repository.applyAction(JitenWordKey(1, 0), JitenReaderAction.Good)

        assertTrue(states.isEmpty())
        assertTrue(transport.requests.isEmpty())
    }

    private fun cardWith(key: JitenWordKey, vararg states: JitenCardState) = JitenCard(
        key = key,
        spelling = "本",
        reading = "ほん",
        frequencyRank = 0,
        partsOfSpeech = emptyList(),
        meanings = emptyList(),
        states = states.toList(),
        pitchAccents = emptyList(),
        studyDeckIds = emptyList(),
    )

    private fun RecordedJitenRequest.sentState(): String =
        (Json.parseToJsonElement(body!!) as JsonObject).getValue("state").jsonPrimitive.content

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
