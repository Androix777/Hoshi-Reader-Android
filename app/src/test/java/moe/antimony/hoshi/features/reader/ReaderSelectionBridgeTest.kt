package moe.antimony.hoshi.features.reader

import moe.antimony.hoshi.features.jiten.JitenWordKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReaderSelectionBridgeTest {
    @Test
    fun parsesTextSelectionPayloadLikeIosMessageBody() {
        val payload = """
            {
                "text": "食べる",
                "sentence": "私は食べる。",
                "rect": {
                    "x": 12.5,
                    "y": 24.25,
                    "width": 40.0,
                    "height": 18.0
                },
                "normalizedOffset": 42,
                "futureField": "ignored"
            }
        """.trimIndent()

        assertEquals(
            ReaderSelectionData(
                text = "食べる",
                sentence = "私は食べる。",
                rect = ReaderSelectionRect(
                    x = 12.5,
                    y = 24.25,
                    width = 40.0,
                    height = 18.0,
                ),
                normalizedOffset = 42,
            ),
            ReaderSelectionBridgePayload.fromJson(payload),
        )
    }

    @Test
    fun carriesTheJitenKeyWhenTheTapLandedOnAColouredWord() {
        val payload = """
            {
                "text": "食べる",
                "sentence": "私は食べる。",
                "rect": { "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0 },
                "normalizedOffset": 42,
                "jiten": { "wordId": 1381, "readingIndex": 0 }
            }
        """.trimIndent()

        assertEquals(
            JitenWordKey(wordId = 1381, readingIndex = 0),
            ReaderSelectionBridgePayload.fromJson(payload)?.jiten,
        )
    }

    @Test
    fun leavesTheJitenKeyUnsetWhereTheTapFoundNoColouredWord() {
        val payload = """
            {
                "text": "食べる",
                "sentence": "私は食べる。",
                "rect": { "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0 },
                "normalizedOffset": 42
            }
        """.trimIndent()

        // The reader posts no `jiten` at all when Jiten is off or unparsed, and
        // that must stay a plain selection rather than fail the whole payload.
        assertNull(ReaderSelectionBridgePayload.fromJson(payload)?.jiten)
        assertEquals("食べる", ReaderSelectionBridgePayload.fromJson(payload)?.text)
    }
}
