package moe.antimony.hoshi.features.jiten

import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.first

/**
 * Turns a chapter's paragraphs into tokens.
 *
 * Splitting the work into requests and putting the answers back where they
 * belong lives here rather than in [JitenApiClient], which knows nothing about
 * chapters, and rather than in the view model, which would then be untestable
 * without a WebView.
 */
@Singleton
class JitenRepository @Inject constructor(
    private val apiClient: JitenApiClient,
    private val settingsRepository: JitenSettingsRepository,
) {
    /**
     * Tokens per paragraph, aligned one-to-one with [paragraphs]. Empty when
     * Jiten is switched off or unconfigured; a paragraph that was never posted
     * gets an empty list rather than shifting its neighbours.
     */
    suspend fun parseChapter(paragraphs: List<String>): List<List<JitenToken>> {
        val settings = settingsRepository.settings.first()
        if (!settings.enabled || settings.apiKey.isBlank()) return emptyList()

        val postable = paragraphs.withIndex().filter { it.value.hasParsableJapanese() }
        if (postable.isEmpty()) return emptyList()

        val tokens = MutableList<List<JitenToken>>(paragraphs.size) { emptyList() }
        postable.chunkedForParse(length = { it.value.length }).forEach { chunk ->
            val parsed = apiClient.parse(chunk.map { it.value }).paragraphs
            chunk.forEachIndexed { position, paragraph ->
                tokens[paragraph.index] = parsed.getOrElse(position) { emptyList() }
            }
        }
        return tokens
    }
}
