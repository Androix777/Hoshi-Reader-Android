package moe.antimony.hoshi.features.reader

import moe.antimony.hoshi.features.jiten.JitenWordKey

data class ReaderSelectionData(
    val text: String,
    val sentence: String,
    val rect: ReaderSelectionRect,
    val normalizedOffset: Int?,
    val sentenceOffset: Int? = null,
    /**
     * The Jiten card the tap landed on, when it landed on a coloured word. Null
     * everywhere else, including for selections made inside a popup. Jiten cuts
     * words differently from the dictionary, so this is not [text]'s key.
     */
    val jiten: JitenWordKey? = null,
)

data class ReaderSelectionRect(
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
)
