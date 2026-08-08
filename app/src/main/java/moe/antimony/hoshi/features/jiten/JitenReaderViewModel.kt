package moe.antimony.hoshi.features.jiten

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

@HiltViewModel
internal class JitenReaderViewModel @Inject constructor(
    private val repository: JitenRepository,
) : ViewModel() {
    private var parseJob: Job? = null

    /**
     * Parse one chapter's paragraphs and hand the tokens back as JSON.
     *
     * Only the newest chapter is worth parsing, so a new request cancels the
     * one before it; the reader also ignores answers to superseded requests, so
     * a response that slips through a cancellation race is harmless.
     */
    fun parseChapter(paragraphsJson: String, onTokens: (String) -> Unit) {
        parseJob?.cancel()
        parseJob = viewModelScope.launch {
            val paragraphs = runCatching { json.decodeFromString<List<String>>(paragraphsJson) }
                .getOrNull() ?: return@launch
            val tokens = try {
                repository.parseChapter(paragraphs)
            } catch (error: JitenApiException) {
                // The reader stays uncoloured. Connection problems are the
                // settings screen's story to tell, not the page's.
                return@launch
            }
            if (tokens.isEmpty()) return@launch
            onTokens(json.encodeToString(tokens.toReaderTokens()))
        }
    }

    private companion object {
        val json = Json { ignoreUnknownKeys = true }
    }
}
