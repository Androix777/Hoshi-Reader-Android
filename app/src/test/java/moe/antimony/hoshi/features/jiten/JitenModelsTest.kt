package moe.antimony.hoshi.features.jiten

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class JitenModelsTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun tokensAreJoinedToTheirVocabularyEntryByWordAndReading() {
        val response = json.decodeFromString<JitenWire.ParseResponse>(
            """
            {
              "tokens": [[
                {"wordId": 1, "readingIndex": 0, "start": 0, "end": 2},
                {"wordId": 1, "readingIndex": 1, "start": 2, "end": 4}
              ]],
              "vocabulary": [
                {"wordId": 1, "readingIndex": 0, "spelling": "何", "reading": "なに", "knownState": [1]},
                {"wordId": 1, "readingIndex": 1, "spelling": "何", "reading": "なん", "knownState": [2]}
              ]
            }
            """.trimIndent(),
        )

        val tokens = response.toParseResult().paragraphs.single()

        assertEquals("なに", tokens[0].card.reading)
        assertEquals("なん", tokens[1].card.reading)
    }

    @Test
    fun tokensWithoutAVocabularyEntryAreDropped() {
        val response = json.decodeFromString<JitenWire.ParseResponse>(
            """
            {
              "tokens": [[{"wordId": 9, "readingIndex": 0, "start": 0, "end": 2}]],
              "vocabulary": []
            }
            """.trimIndent(),
        )

        assertTrue(response.toParseResult().paragraphs.single().isEmpty())
    }

    @Test
    fun emptyAndUnknownRangesAreDropped() {
        val response = json.decodeFromString<JitenWire.ParseResponse>(
            """
            {
              "tokens": [[
                {"wordId": 1, "readingIndex": 0, "start": 3, "end": 3},
                {"wordId": 1, "readingIndex": 0, "start": 5, "end": 4},
                {"wordId": 1, "readingIndex": 0, "start": 6, "end": 8}
              ]],
              "vocabulary": [{"wordId": 1, "readingIndex": 0, "knownState": [0]}]
            }
            """.trimIndent(),
        )

        val tokens = response.toParseResult().paragraphs.single()

        assertEquals(1, tokens.size)
        assertEquals(6, tokens.single().startUtf16)
        assertEquals(8, tokens.single().endUtf16)
    }

    @Test
    fun compositeKnownStatesKeepEveryRecognizedState() {
        val states = listOf(2, 6).toCardStates(fallback = JitenCardState.Mature)

        assertEquals(listOf(JitenCardState.Mature, JitenCardState.Redundant), states)
    }

    @Test
    fun unrecognizedKnownStatesFallBackWithoutHidingKnownOnes() {
        assertEquals(listOf(JitenCardState.Mature), listOf(99).toCardStates(JitenCardState.Mature))
        assertEquals(listOf(JitenCardState.New), emptyList<Int>().toCardStates(JitenCardState.New))
        assertEquals(listOf(JitenCardState.Due), listOf(99, 4).toCardStates(JitenCardState.Mature))
    }

    @Test
    fun partsOfSpeechAcceptsABareStringAsWellAsAnArray() {
        val asArray = json.decodeFromString<JitenWire.Vocabulary>(
            """{"wordId":1,"readingIndex":0,"partsOfSpeech":["n","vs"]}""",
        )
        val asString = json.decodeFromString<JitenWire.Vocabulary>(
            """{"wordId":1,"readingIndex":0,"partsOfSpeech":"prt"}""",
        )
        val asNull = json.decodeFromString<JitenWire.Vocabulary>(
            """{"wordId":1,"readingIndex":0,"partsOfSpeech":null}""",
        )

        assertEquals(listOf("n", "vs"), asArray.partsOfSpeech)
        assertEquals(listOf("prt"), asString.partsOfSpeech)
        assertTrue(asNull.partsOfSpeech.isEmpty())
    }

    @Test
    fun meaningsPairGlossesWithTheirOwnPartsOfSpeech() {
        val card = json.decodeFromString<JitenWire.Vocabulary>(
            """
            {
              "wordId": 1,
              "readingIndex": 0,
              "meaningsChunks": [["time", "hour"], ["period"]],
              "meaningsPartOfSpeech": [["n"]]
            }
            """.trimIndent(),
        ).toCard()

        assertEquals(listOf("time", "hour"), card.meanings[0].glosses)
        assertEquals(listOf("n"), card.meanings[0].partsOfSpeech)
        assertEquals(listOf("period"), card.meanings[1].glosses)
        assertTrue(card.meanings[1].partsOfSpeech.isEmpty())
    }

    @Test
    fun cardStatesHaveDistinctWireValuesAndClassNames() {
        assertEquals(
            JitenCardState.entries.size,
            JitenCardState.entries.map { it.wireValue }.distinct().size,
        )
        assertEquals(
            JitenCardState.entries.size,
            JitenCardState.entries.map { it.cssClass }.distinct().size,
        )
        JitenCardState.entries.forEach { state ->
            assertEquals(state, JitenCardState.fromWireValue(state.wireValue))
        }
    }
}
