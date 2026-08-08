package moe.antimony.hoshi.features.jiten

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

/**
 * Answers the reader's parse requests, one unit of text at a time.
 *
 * Units are small and arrive as the reader approaches them, so several can be
 * outstanding at once; [JitenRepository] is what keeps them from reaching the
 * API in parallel.
 */
@HiltViewModel
internal class JitenReaderViewModel @Inject constructor(
    private val repository: JitenRepository,
    settingsRepository: JitenSettingsRepository,
) : ViewModel() {
    private val jobs = mutableMapOf<String, Job>()
    private var session: String? = null
    private val settings = settingsRepository.settings.stateIn(
        scope = viewModelScope,
        started = SharingStarted.Eagerly,
        initialValue = JitenSettings(),
    )

    /**
     * Retires the previous page load's work. A replaced page never says
     * goodbye, so the new one announcing itself is the only signal there is.
     */
    fun beginSession(sessionId: String) {
        if (session == sessionId) return
        session = sessionId
        cancelAll()
    }

    /**
     * Answers with tokens or with [onFailed], never with silence: the reader
     * holds the text as pending until it hears back, and only asks again once
     * told the attempt failed.
     */
    fun parse(
        requestId: String,
        paragraphsJson: String,
        onTokens: (String) -> Unit,
        onFailed: () -> Unit,
    ) {
        jobs[requestId]?.cancel()
        jobs[requestId] = viewModelScope.launch {
            try {
                val paragraphs = runCatching { json.decodeFromString<List<String>>(paragraphsJson) }
                    .getOrNull() ?: return@launch
                val tokens = try {
                    repository.parseChapter(paragraphs)
                } catch (error: JitenApiException) {
                    // Connection problems are the settings screen's story to
                    // tell, not the page's.
                    onFailed()
                    return@launch
                }
                // Empty is an answer, not a failure: Jiten is off, or there was
                // nothing to parse. Neither is fixed by asking again.
                onTokens(json.encodeToString(tokens.toReaderTokens()))
            } finally {
                jobs.remove(requestId)
            }
        }
    }

    /** The text scrolled out of reach before its answer arrived. */
    fun cancel(requestId: String) {
        jobs.remove(requestId)?.cancel()
    }

    /**
     * The card behind a tapped word, as JSON for the popup, or null if parsing
     * never met it. Serialized here rather than in the reader so the popup's
     * wire shape stays inside the feature.
     */
    fun cardJson(key: JitenWordKey): String? =
        repository.card(key)?.let { card ->
            json.encodeToString(card.toPopupCard(settings.value.visibleActions))
        }

    /**
     * Carries out a card action, answering with the resulting state names or
     * null if it could not be done. A failure has to reach the page: it is what
     * puts the buttons back, and a silent one would leave them waiting.
     */
    fun act(key: JitenWordKey, action: JitenReaderAction, onDone: (List<String>?) -> Unit) {
        viewModelScope.launch {
            val states = try {
                repository.applyAction(key, action).map(JitenCardState::cssClass)
            } catch (error: JitenApiException) {
                null
            }
            onDone(states)
        }
    }

    override fun onCleared() {
        cancelAll()
        super.onCleared()
    }

    private fun cancelAll() {
        jobs.values.toList().forEach(Job::cancel)
        jobs.clear()
    }

    private companion object {
        val json = Json { ignoreUnknownKeys = true }
    }
}
