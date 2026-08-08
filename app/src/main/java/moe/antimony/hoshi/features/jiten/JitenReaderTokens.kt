package moe.antimony.hoshi.features.jiten

import kotlinx.serialization.Serializable

/**
 * One coloured word in the shape `reader-jiten-highlight.js` consumes.
 *
 * [start] and [end] are UTF-16 code units into the posted paragraph, matching
 * what Jiten returned; [states] are the CSS suffixes appended to `jiten-`.
 */
@Serializable
internal data class JitenReaderToken(
    val start: Int,
    val end: Int,
    val wordId: Int,
    val readingIndex: Int,
    val states: List<String>,
)

internal fun List<List<JitenToken>>.toReaderTokens(): List<List<JitenReaderToken>> =
    map { paragraph ->
        paragraph.map { token ->
            JitenReaderToken(
                start = token.startUtf16,
                end = token.endUtf16,
                wordId = token.card.key.wordId,
                readingIndex = token.card.key.readingIndex,
                states = token.card.states.map(JitenCardState::cssClass),
            )
        }
    }

/**
 * What the Jiten page offers to do with a card.
 *
 * Named for the button rather than for the request: Never Forget and Blacklist
 * are memberships that toggle, and which way they toggle depends on the card's
 * current state. That decision belongs here, next to the state, and not in a
 * page that would have to be told the answer first.
 */
internal enum class JitenReaderAction(val wireName: String) {
    Again("again"),
    Hard("hard"),
    Good("good"),
    Easy("easy"),
    NeverForget("neverForget"),
    Blacklist("blacklist"),
    Forget("forget"),
    ;

    val rating: JitenRating?
        get() = when (this) {
            Again -> JitenRating.Again
            Hard -> JitenRating.Hard
            Good -> JitenRating.Good
            Easy -> JitenRating.Easy
            else -> null
        }

    companion object {
        fun fromWireName(name: String): JitenReaderAction? = entries.firstOrNull { it.wireName == name }
    }
}

/**
 * One card in the shape `popup-jiten.js` renders.
 *
 * Deliberately not [JitenCard]: the popup needs a stable wire contract, and the
 * card carries fields it has no use for. [states] are the same CSS suffixes the
 * coloured spans carry, so the popup and the chapter agree on what a word is.
 */
@Serializable
internal data class JitenPopupCard(
    val wordId: Int,
    val readingIndex: Int,
    val spelling: String,
    val reading: String,
    val frequencyRank: Int,
    val states: List<String>,
    val meanings: List<JitenPopupMeaning>,
)

@Serializable
internal data class JitenPopupMeaning(
    val glosses: List<String>,
    val partsOfSpeech: List<String>,
)

internal fun JitenCard.toPopupCard(): JitenPopupCard =
    JitenPopupCard(
        wordId = key.wordId,
        readingIndex = key.readingIndex,
        spelling = spelling,
        reading = reading,
        frequencyRank = frequencyRank,
        states = states.map(JitenCardState::cssClass),
        meanings = meanings.map { meaning ->
            JitenPopupMeaning(glosses = meaning.glosses, partsOfSpeech = meaning.partsOfSpeech)
        },
    )

/**
 * Paragraphs worth a parse request. A chapter is mostly prose but also holds
 * page numbers, Latin front matter and stray punctuation; posting those spends
 * the parse budget on text that can produce no card.
 */
internal fun String.hasParsableJapanese(): Boolean = any { char ->
    val code = char.code
    // Kana, CJK ideographs and their compatibility block. Deliberately excludes
    // U+3000..U+303F, which is punctuation a paragraph can consist entirely of.
    (code in 0x3040..0x30FF) || (code in 0x3400..0x9FFF) || (code in 0xF900..0xFAFF)
}

/**
 * Group paragraphs into request-sized batches. A single paragraph over the
 * limit still travels alone: splitting it would renumber the offsets Jiten
 * returns against text the reader never posted.
 */
internal fun <T> List<T>.chunkedForParse(
    length: (T) -> Int,
    maxCharacters: Int = MaxParseCharacters,
    maxParagraphs: Int = MaxParseParagraphs,
): List<List<T>> {
    val chunks = mutableListOf<List<T>>()
    var current = mutableListOf<T>()
    var characters = 0
    forEach { item ->
        val size = length(item)
        if (current.isNotEmpty() && (characters + size > maxCharacters || current.size >= maxParagraphs)) {
            chunks.add(current)
            current = mutableListOf()
            characters = 0
        }
        current.add(item)
        characters += size
    }
    if (current.isNotEmpty()) chunks.add(current)
    return chunks
}

private const val MaxParseCharacters = 3_000
private const val MaxParseParagraphs = 60
