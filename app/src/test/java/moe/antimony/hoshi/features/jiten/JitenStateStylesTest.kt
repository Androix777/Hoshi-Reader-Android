package moe.antimony.hoshi.features.jiten

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class JitenStateStylesTest {
    @Test
    fun readerCssUsesTextAndAlphaBackgroundWithoutLayoutProperties() {
        val dueStyle = JitenStateStyle(
            textEnabled = true,
            backgroundEnabled = true,
            textColor = 0xFF123456,
            backgroundColor = 0x80112233,
        )
        val settings = JitenSettings(
            stateStyles = JitenCardState.entries.associateWith {
                JitenStateStyle(
                    textEnabled = false,
                    backgroundEnabled = false,
                    textColor = 0,
                    backgroundColor = 0,
                )
            } + (JitenCardState.Due to dueStyle),
        )

        val css = settings.readerStyleCss()

        assertTrue(css.contains(".jiten-word.jiten-due"))
        assertTrue(css.contains("color: #123456 !important"))
        assertTrue(css.contains("background-color: #11223380 !important"))
        assertFalse(css.contains("padding"))
        assertFalse(css.contains("border"))
    }

    @Test
    fun disablingBothChannelsProducesNoRule() {
        val disabledNew = DefaultJitenStateStyles.getValue(JitenCardState.New).copy(textEnabled = false)
        val css = JitenSettings(
            stateStyles = DefaultJitenStateStyles + (JitenCardState.New to disabledNew),
        ).readerStyleCss()

        assertFalse(css.contains(".jiten-word.jiten-new"))
        assertTrue(css.contains(".jiten-word.jiten-young"))
    }

    @Test
    fun textAndBackgroundCanIndependentlyInheritReaderColours() {
        val defaults = JitenSettings()

        val newRule = defaults.readerStyleCss().lineSequence().single { it.contains("jiten-new") }
        val redundantRule = defaults.readerStyleCss().lineSequence().single { it.contains("jiten-redundant") }

        assertTrue(newRule.contains("color:"))
        assertFalse(newRule.contains("background-color:"))
        assertFalse(redundantRule.contains(" color:"))
        assertTrue(redundantRule.contains("background-color:"))
    }

    @Test
    fun cssColorKeepsAlphaOnlyWhenRequested() {
        assertEquals("#112233", 0x80112233.toJitenCssColor())
        assertEquals("#11223380", 0x80112233.toJitenCssColor(includeAlpha = true))
    }
}
