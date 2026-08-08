package moe.antimony.hoshi.features.jiten

import org.junit.Assert.assertEquals
import org.junit.Test

class JitenReaderTokensTest {
    @Test
    fun popupCardCarriesVisibleActionsInStableDisplayOrder() {
        val card = JitenCard(
            key = JitenWordKey(wordId = 1, readingIndex = 0),
            spelling = "本",
            reading = "ほん",
            frequencyRank = 1,
            partsOfSpeech = emptyList(),
            meanings = emptyList(),
            states = listOf(JitenCardState.Due),
            pitchAccents = emptyList(),
            studyDeckIds = emptyList(),
        )

        val popup = card.toPopupCard(
            setOf(JitenReaderAction.Blacklist, JitenReaderAction.Again, JitenReaderAction.Easy),
        )

        assertEquals(listOf("again", "easy", "blacklist"), popup.actions)
    }
}
