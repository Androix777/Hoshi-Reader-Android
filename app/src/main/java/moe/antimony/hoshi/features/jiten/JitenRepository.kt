package moe.antimony.hoshi.features.jiten

import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

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
     * Holds the API to one request at a time, in the order it was asked. The
     * reader asks for many small units as it scrolls; Jiten is one hosted
     * service with its own limits.
     */
    private val requests = Mutex()

    /**
     * Cards met while parsing, so a tap can be answered without asking the
     * server for what it just sent. Access-ordered and bounded: the reader
     * parses everything it scrolls past, so without a limit a long book would
     * accumulate every word in it, while a tap only ever asks after a word on
     * screen — which is among the most recently parsed by construction.
     */
    private val cards = object : LinkedHashMap<JitenWordKey, JitenCard>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: Map.Entry<JitenWordKey, JitenCard>): Boolean =
            size > MaxCachedCards
    }

    /**
     * The card for a tapped word, or null if it was never parsed — Jiten off,
     * the paragraph not reached yet, or evicted. Callers fall back to asking.
     */
    fun card(key: JitenWordKey): JitenCard? = synchronized(cards) { cards[key] }

    /** Replaces what is cached for these words, states included. */
    fun rememberCards(updated: Collection<JitenCard>) {
        if (updated.isEmpty()) return
        synchronized(cards) { updated.forEach { cards[it.key] = it } }
    }

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
        requests.withLock {
            postable.chunkedForParse(length = { it.value.length }).forEach { chunk ->
                val parsed = apiClient.parse(chunk.map { it.value }).paragraphs
                chunk.forEachIndexed { position, paragraph ->
                    tokens[paragraph.index] = parsed.getOrElse(position) { emptyList() }
                }
            }
        }
        rememberCards(tokens.flatten().map(JitenToken::card))
        return tokens
    }

    /**
     * Carries out a card action and answers with the states the server ends up
     * holding, which the caller repaints from.
     *
     * The states are read back rather than predicted. A grade moves a card by
     * rules that live on the server, so guessing the outcome would show the
     * reader a state that is right only by luck; the extra round trip buys the
     * difference between reporting and inventing.
     */
    internal suspend fun applyAction(key: JitenWordKey, action: JitenReaderAction): List<JitenCardState> {
        val settings = settingsRepository.settings.first()
        if (!settings.enabled || settings.apiKey.isBlank()) return emptyList()

        return requests.withLock {
            val rating = action.rating
            if (rating != null) {
                apiClient.review(key, rating)
            } else {
                apiClient.setVocabularyState(key, deckActionFor(key, action))
            }
            val states = apiClient.lookupVocabulary(listOf(key)).getValue(key)
            card(key)?.let { rememberCards(listOf(it.copy(states = states))) }
            states
        }
    }

    /**
     * Which way a membership toggles. An unknown card — never parsed, or long
     * enough ago to have been evicted — is treated as not a member, so the
     * action adds. Adding twice is harmless; refusing to act is not.
     */
    private fun deckActionFor(key: JitenWordKey, action: JitenReaderAction): JitenDeckAction {
        val states = card(key)?.states.orEmpty()
        return when (action) {
            JitenReaderAction.NeverForget ->
                if (JitenCardState.Mastered in states) {
                    JitenDeckAction.NeverForgetRemove
                } else {
                    JitenDeckAction.NeverForgetAdd
                }
            JitenReaderAction.Blacklist ->
                if (JitenCardState.Blacklisted in states) {
                    JitenDeckAction.BlacklistRemove
                } else {
                    JitenDeckAction.BlacklistAdd
                }
            else -> JitenDeckAction.Forget
        }
    }

    private companion object {
        /**
         * Roughly a long chapter's distinct vocabulary. The point is a ceiling,
         * not a working set: eviction only costs a tap one extra request.
         */
        const val MaxCachedCards = 2_000
    }
}
