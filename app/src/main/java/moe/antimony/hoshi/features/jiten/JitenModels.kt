package moe.antimony.hoshi.features.jiten

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonTransformingSerializer
import kotlinx.serialization.json.buildJsonArray

/**
 * Identifies one Jiten card. A word may have several readings, so neither half is
 * unique on its own.
 */
data class JitenWordKey(
    val wordId: Int,
    val readingIndex: Int,
)

/**
 * Card states as returned in `knownState`. A word carries one tier state
 * (New/Young/Mature/Mastered/Blacklisted) or Due, optionally accompanied by
 * Redundant or Suspended, so a card always has a list rather than a single value.
 */
enum class JitenCardState(
    val wireValue: Int,
    val cssClass: String,
) {
    New(0, "new"),
    Young(1, "young"),
    Mature(2, "mature"),
    Blacklisted(3, "blacklisted"),
    Due(4, "due"),
    Mastered(5, "mastered"),
    Redundant(6, "redundant"),
    Suspended(7, "suspended"),
    ;

    companion object {
        fun fromWireValue(value: Int): JitenCardState? = entries.firstOrNull { it.wireValue == value }
    }
}

enum class JitenRating(val wireValue: Int) {
    Unknown(0),
    Again(1),
    Hard(2),
    Good(3),
    Easy(4),
}

enum class JitenStudyDeckType(val wireValue: Int) {
    MediaDeck(0),
    GlobalDynamic(1),
    StaticWordList(2),
    ;

    companion object {
        fun fromWireValue(value: Int): JitenStudyDeckType? = entries.firstOrNull { it.wireValue == value }
    }
}

data class JitenStudyDeck(
    val id: Int,
    val name: String,
    val type: JitenStudyDeckType?,
)

data class JitenMeaning(
    val glosses: List<String>,
    val partsOfSpeech: List<String>,
)

data class JitenCard(
    val key: JitenWordKey,
    val spelling: String,
    val reading: String,
    val frequencyRank: Int,
    val partsOfSpeech: List<String>,
    val meanings: List<JitenMeaning>,
    val states: List<JitenCardState>,
    val pitchAccents: List<Int>,
    val studyDeckIds: List<Int>,
)

/**
 * One parsed word inside a single posted paragraph.
 *
 * [startUtf16] and [endUtf16] index the exact string that was posted to
 * `reader/parse`, counted in UTF-16 code units. They are deliberately not
 * comparable to the reader's own offsets, which count Unicode code points over
 * text normalized by `reader-text-semantics.js`.
 */
data class JitenToken(
    val startUtf16: Int,
    val endUtf16: Int,
    val card: JitenCard,
)

/** Parsed tokens per posted paragraph, in the order the paragraphs were posted. */
data class JitenParseResult(
    val paragraphs: List<List<JitenToken>>,
)

internal object JitenWire {
    @Serializable
    data class ParseRequest(val text: List<String>)

    @Serializable
    data class ParseResponse(
        val tokens: List<List<Token>> = emptyList(),
        val vocabulary: List<Vocabulary> = emptyList(),
    )

    @Serializable
    data class Token(
        val wordId: Int,
        val readingIndex: Int,
        val start: Int,
        val end: Int,
    )

    @Serializable
    data class Vocabulary(
        val wordId: Int,
        val readingIndex: Int,
        val spelling: String = "",
        val reading: String = "",
        val frequencyRank: Int = 0,
        @Serializable(with = FlexibleStringListSerializer::class)
        val partsOfSpeech: List<String> = emptyList(),
        val meaningsChunks: List<List<String>> = emptyList(),
        val meaningsPartOfSpeech: List<List<String>> = emptyList(),
        val knownState: List<Int> = emptyList(),
        val pitchAccents: List<Int>? = null,
        val studyDeckIds: List<Int> = emptyList(),
    )

    @Serializable
    data class LookupVocabularyRequest(val words: List<List<Int>>)

    @Serializable
    data class LookupVocabularyResponse(
        val result: List<List<Int>> = emptyList(),
        val decks: List<List<Int>> = emptyList(),
    )

    @Serializable
    data class ReviewRequest(
        val wordId: Int,
        val readingIndex: Int,
        val rating: Int,
    )

    @Serializable
    data class SetVocabularyStateRequest(
        val wordId: Int,
        val readingIndex: Int,
        val state: String,
    )

    @Serializable
    data class StudyDeck(
        val userStudyDeckId: Int,
        val name: String = "",
        val deckType: Int = -1,
    )

    @Serializable
    data class ErrorResponse(
        @SerialName("error_message") val errorMessage: String? = null,
    )
}

/**
 * `partsOfSpeech` arrives either as an array or as a bare string; the browser
 * extension normalizes the same way rather than failing the whole parse.
 */
internal object FlexibleStringListSerializer : JsonTransformingSerializer<List<String>>(
    ListSerializer(String.serializer()),
) {
    override fun transformDeserialize(element: JsonElement): JsonElement = when (element) {
        is JsonArray -> element
        JsonNull -> buildJsonArray { }
        else -> buildJsonArray { add(element) }
    }
}

internal fun JitenWire.Vocabulary.toCard(): JitenCard =
    JitenCard(
        key = JitenWordKey(wordId = wordId, readingIndex = readingIndex),
        spelling = spelling,
        reading = reading,
        frequencyRank = frequencyRank,
        partsOfSpeech = partsOfSpeech,
        meanings = meaningsChunks.mapIndexed { index, glosses ->
            JitenMeaning(
                glosses = glosses,
                partsOfSpeech = meaningsPartOfSpeech.getOrElse(index) { emptyList() },
            )
        },
        states = knownState.toCardStates(fallback = JitenCardState.Mature),
        pitchAccents = pitchAccents ?: emptyList(),
        studyDeckIds = studyDeckIds,
    )

/**
 * A card with no recognized state is treated as [fallback]. The reading path uses
 * [JitenCardState.Mature] so an unmappable state never paints a word as unseen,
 * while state refreshes use [JitenCardState.New]; both mirror the extension.
 */
internal fun List<Int>.toCardStates(fallback: JitenCardState): List<JitenCardState> {
    val mapped = mapNotNull(JitenCardState::fromWireValue)
    return mapped.ifEmpty { listOf(fallback) }
}

internal fun JitenWire.ParseResponse.toParseResult(): JitenParseResult {
    val cards = vocabulary.associate { entry ->
        JitenWordKey(entry.wordId, entry.readingIndex) to entry.toCard()
    }
    return JitenParseResult(
        paragraphs = tokens.map { paragraph ->
            paragraph.mapNotNull { token ->
                val card = cards[JitenWordKey(token.wordId, token.readingIndex)] ?: return@mapNotNull null
                if (token.end <= token.start) return@mapNotNull null
                JitenToken(startUtf16 = token.start, endUtf16 = token.end, card = card)
            }
        },
    )
}
