package moe.antimony.hoshi.features.jiten

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * Jiten is one account against one hosted service, so these stay global rather
 * than profile-scoped like Reader appearance or Anki settings.
 */
data class JitenSettings(
    val enabled: Boolean = false,
    val apiKey: String = "",
    val visibleActions: Set<JitenReaderAction> = JitenReaderAction.entries.toSet(),
    val stateStyles: Map<JitenCardState, JitenStateStyle> = DefaultJitenStateStyles,
)

interface JitenSettingsRepository {
    val settings: Flow<JitenSettings>
    suspend fun update(transform: (JitenSettings) -> JitenSettings)
}

private val Context.jitenSettingsDataStore by preferencesDataStore(
    name = DataStoreJitenSettingsRepository.DataStoreName,
)

fun Context.jitenSettingsRepository(): JitenSettingsRepository =
    DataStoreJitenSettingsRepository(jitenSettingsDataStore)

class DataStoreJitenSettingsRepository(
    private val dataStore: DataStore<Preferences>,
) : JitenSettingsRepository {
    override val settings: Flow<JitenSettings> =
        dataStore.data.map { preferences -> preferences.toJitenSettings() }

    override suspend fun update(transform: (JitenSettings) -> JitenSettings) {
        dataStore.edit { preferences ->
            preferences.writeJitenSettings(transform(preferences.toJitenSettings()))
        }
    }

    private fun Preferences.toJitenSettings(): JitenSettings =
        JitenSettings(
            enabled = this[KEY_ENABLED] ?: false,
            apiKey = this[KEY_API_KEY].orEmpty(),
            visibleActions = JitenReaderAction.entries
                .filterNot { action -> action.wireName in this[KEY_HIDDEN_ACTIONS].orEmpty() }
                .toSet(),
            stateStyles = JitenCardState.entries.associateWith { state ->
                val defaults = checkNotNull(DefaultJitenStateStyles[state])
                val legacyEnabled = this[KEY_STYLE_ENABLED_LEGACY.getValue(state)]
                JitenStateStyle(
                    textEnabled = this[KEY_STYLE_TEXT_ENABLED.getValue(state)]
                        ?: legacyEnabled
                        ?: defaults.textEnabled,
                    backgroundEnabled = this[KEY_STYLE_BACKGROUND_ENABLED.getValue(state)]
                        ?: legacyEnabled
                        ?: defaults.backgroundEnabled,
                    textColor = this[KEY_STYLE_TEXT.getValue(state)] ?: defaults.textColor,
                    backgroundColor = this[KEY_STYLE_BACKGROUND.getValue(state)] ?: defaults.backgroundColor,
                )
            },
        )

    private fun MutablePreferences.writeJitenSettings(settings: JitenSettings) {
        this[KEY_ENABLED] = settings.enabled
        this[KEY_API_KEY] = settings.apiKey
        this[KEY_HIDDEN_ACTIONS] = JitenReaderAction.entries
            .filterNot(settings.visibleActions::contains)
            .mapTo(mutableSetOf(), JitenReaderAction::wireName)
        JitenCardState.entries.forEach { state ->
            val style = settings.styleFor(state)
            this[KEY_STYLE_TEXT_ENABLED.getValue(state)] = style.textEnabled
            this[KEY_STYLE_BACKGROUND_ENABLED.getValue(state)] = style.backgroundEnabled
            this[KEY_STYLE_TEXT.getValue(state)] = style.textColor
            this[KEY_STYLE_BACKGROUND.getValue(state)] = style.backgroundColor
        }
    }

    companion object {
        const val DataStoreName = "jiten-settings"

        private val KEY_ENABLED = booleanPreferencesKey("jitenEnabled")
        private val KEY_API_KEY = stringPreferencesKey("jitenApiKey")
        private val KEY_HIDDEN_ACTIONS = stringSetPreferencesKey("jitenHiddenActions")
        private val KEY_STYLE_ENABLED_LEGACY = JitenCardState.entries.associateWith { state ->
            booleanPreferencesKey("jitenStyle_${state.cssClass}_enabled")
        }
        private val KEY_STYLE_TEXT_ENABLED = JitenCardState.entries.associateWith { state ->
            booleanPreferencesKey("jitenStyle_${state.cssClass}_textEnabled")
        }
        private val KEY_STYLE_BACKGROUND_ENABLED = JitenCardState.entries.associateWith { state ->
            booleanPreferencesKey("jitenStyle_${state.cssClass}_backgroundEnabled")
        }
        private val KEY_STYLE_TEXT = JitenCardState.entries.associateWith { state ->
            longPreferencesKey("jitenStyle_${state.cssClass}_text")
        }
        private val KEY_STYLE_BACKGROUND = JitenCardState.entries.associateWith { state ->
            longPreferencesKey("jitenStyle_${state.cssClass}_background")
        }
    }
}
