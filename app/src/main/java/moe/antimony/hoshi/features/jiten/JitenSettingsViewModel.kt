package moe.antimony.hoshi.features.jiten

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import moe.antimony.hoshi.R
import moe.antimony.hoshi.ui.UiText

enum class JitenConnectionStatus {
    Unknown,
    Connected,
    Failed,
}

data class JitenSettingsUiState(
    val settings: JitenSettings = JitenSettings(),
    val isTestingConnection: Boolean = false,
    val connectionStatus: JitenConnectionStatus = JitenConnectionStatus.Unknown,
    val connectionMessage: UiText? = null,
)

@HiltViewModel
internal class JitenSettingsViewModel @Inject constructor(
    private val settingsRepository: JitenSettingsRepository,
    private val apiClient: JitenApiClient,
) : ViewModel() {
    private val _uiState = MutableStateFlow(JitenSettingsUiState())
    val uiState: StateFlow<JitenSettingsUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            settingsRepository.settings.collectLatest { settings ->
                _uiState.value = _uiState.value.copy(settings = settings)
            }
        }
    }

    fun updateEnabled(enabled: Boolean) {
        viewModelScope.launch {
            settingsRepository.update { it.copy(enabled = enabled) }
        }
    }

    fun updateApiKey(apiKey: String) {
        val trimmed = apiKey.trim()
        viewModelScope.launch {
            settingsRepository.update { it.copy(apiKey = trimmed) }
            _uiState.value = _uiState.value.copy(
                connectionStatus = JitenConnectionStatus.Unknown,
                connectionMessage = null,
            )
        }
    }

    /**
     * Pings with the stored key passed explicitly so a freshly saved key is
     * re-checked against the server even after an earlier key was rejected.
     */
    fun testConnection() {
        val apiKey = _uiState.value.settings.apiKey
        if (apiKey.isBlank()) {
            _uiState.value = _uiState.value.copy(
                connectionStatus = JitenConnectionStatus.Failed,
                connectionMessage = UiText.Resource(R.string.jiten_api_key_missing),
            )
            return
        }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isTestingConnection = true, connectionMessage = null)
            val result = runCatching { apiClient.ping(apiKey) }
            _uiState.value = _uiState.value.copy(
                isTestingConnection = false,
                connectionStatus = if (result.isSuccess) {
                    JitenConnectionStatus.Connected
                } else {
                    JitenConnectionStatus.Failed
                },
                connectionMessage = result.exceptionOrNull()?.jitenFailureMessage(),
            )
        }
    }
}

private fun Throwable.jitenFailureMessage(): UiText {
    val apiException = this as? JitenApiException
    return when (apiException?.failure) {
        JitenFailure.NotConfigured -> UiText.Resource(R.string.jiten_api_key_missing)
        JitenFailure.Unauthorized -> UiText.Resource(R.string.jiten_connection_unauthorized)
        JitenFailure.Server -> apiException.statusCode
            ?.let { status -> UiText.Resource(R.string.jiten_connection_server_error_code, status) }
            ?: UiText.Resource(R.string.jiten_connection_server_error)
        else -> UiText.Resource(R.string.jiten_connection_unreachable)
    }
}
