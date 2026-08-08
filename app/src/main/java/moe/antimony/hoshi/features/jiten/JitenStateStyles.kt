package moe.antimony.hoshi.features.jiten

data class JitenStateStyle(
    val textEnabled: Boolean,
    val backgroundEnabled: Boolean,
    val textColor: Long,
    val backgroundColor: Long,
)

internal val DefaultJitenStateStyles: Map<JitenCardState, JitenStateStyle> = mapOf(
    JitenCardState.New to JitenStateStyle(true, false, 0xFF4B8DFF, 0x00000000),
    JitenCardState.Young to JitenStateStyle(true, false, 0xFF4AC34A, 0x00000000),
    JitenCardState.Mature to JitenStateStyle(false, false, 0xFF2F9D78, 0x00000000),
    JitenCardState.Mastered to JitenStateStyle(false, false, 0xFF8B6DCC, 0x00000000),
    JitenCardState.Due to JitenStateStyle(true, false, 0xFFE8A735, 0x00000000),
    JitenCardState.Blacklisted to JitenStateStyle(true, false, 0xFF777777, 0x00000000),
    JitenCardState.Redundant to JitenStateStyle(false, true, 0xFF4B8DFF, 0x294B8DFF),
    JitenCardState.Suspended to JitenStateStyle(true, false, 0xFF777777, 0x00000000),
)

internal fun JitenSettings.styleFor(state: JitenCardState): JitenStateStyle =
    stateStyles[state] ?: checkNotNull(DefaultJitenStateStyles[state])

/**
 * State order is also CSS priority for cards that carry modifiers alongside a
 * learning state. Suspended wins last; it should never look actionable.
 */
private val JitenStylePriority = listOf(
    JitenCardState.New,
    JitenCardState.Young,
    JitenCardState.Mature,
    JitenCardState.Mastered,
    JitenCardState.Due,
    JitenCardState.Blacklisted,
    JitenCardState.Redundant,
    JitenCardState.Suspended,
)

internal fun JitenSettings.readerStyleCss(): String =
    JitenStylePriority.mapNotNull { state ->
        val style = styleFor(state)
        val declarations = buildList {
            if (style.textEnabled) {
                add("color: ${style.textColor.toJitenCssColor(includeAlpha = true)} !important;")
            }
            if (style.backgroundEnabled) {
                add(
                    "background-color: ${style.backgroundColor.toJitenCssColor(includeAlpha = true)} " +
                        "!important;",
                )
            }
        }
        if (declarations.isEmpty()) return@mapNotNull null
        ".jiten-word.jiten-${state.cssClass} { ${declarations.joinToString(" ")} }"
    }.joinToString("\n")

internal fun Long.toJitenCssColor(includeAlpha: Boolean = false): String {
    val rgb = this and 0xFFFFFF
    val alpha = (this ushr 24) and 0xFF
    val value = rgb.toString(16).padStart(6, '0')
    return if (includeAlpha && alpha != 0xFFL) {
        "#$value${alpha.toString(16).padStart(2, '0')}"
    } else {
        "#$value"
    }
}
