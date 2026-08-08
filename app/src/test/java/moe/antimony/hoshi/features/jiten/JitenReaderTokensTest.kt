package moe.antimony.hoshi.features.jiten

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
            JitenSettings(
                visibleActions = setOf(
                    JitenReaderAction.Blacklist,
                    JitenReaderAction.Again,
                    JitenReaderAction.Easy,
                ),
            ),
        )

        assertEquals(listOf("again", "easy", "blacklist"), popup.actions)
        assertEquals("#4b8dff", popup.styles.getValue("new").textColor)
        assertNull(popup.styles.getValue("new").backgroundColor)
        assertEquals(false, "mature" in popup.styles)
    }
}
