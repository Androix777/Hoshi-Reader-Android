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
