package moe.antimony.hoshi.features.jiten

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
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
        )

    private fun MutablePreferences.writeJitenSettings(settings: JitenSettings) {
        this[KEY_ENABLED] = settings.enabled
        this[KEY_API_KEY] = settings.apiKey
    }

    companion object {
        const val DataStoreName = "jiten-settings"

        private val KEY_ENABLED = booleanPreferencesKey("jitenEnabled")
        private val KEY_API_KEY = stringPreferencesKey("jitenApiKey")
    }
}
