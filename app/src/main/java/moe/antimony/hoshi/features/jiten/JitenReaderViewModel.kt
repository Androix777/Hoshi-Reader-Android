package moe.antimony.hoshi.features.jiten

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.Job
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
) : ViewModel() {
    private val jobs = mutableMapOf<String, Job>()
    private var session: String? = null

    /**
     * A new page load supersedes everything still queued for the old one. The
     * reader never says goodbye — the page is simply replaced — so the first
     * request of a new chapter is what retires the previous chapter's work.
     */
    fun beginSession(sessionId: String) {
        if (session == sessionId) return
        session = sessionId
        cancelAll()
    }

    /**
     * [onFailed] is not cosmetic: the reader watches text for one crossing into
     * view and no more, so a request that never comes back leaves that text
     * uncoloured for as long as it stays on screen. Saying so is what lets the
     * reader ask again.
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
                    // The page says nothing about it: connection problems are
                    // the settings screen's story to tell.
                    onFailed()
                    return@launch
                }
                // Empty means Jiten is switched off or the text holds nothing to
                // parse — settled, not failed, and retrying would never help.
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
