package moe.antimony.hoshi.features.jiten

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class JitenSettingsRepositoryTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun everyActionIsVisibleByDefault() = runBlocking {
        repository().use { handle ->
            val settings = handle.repository.settings.first()
            assertEquals(JitenReaderAction.entries.toSet(), settings.visibleActions)
            assertEquals(DefaultJitenStateStyles, settings.stateStyles)
        }
    }

    @Test
    fun hiddenActionsAndStateStylesArePersisted() = runBlocking {
        repository().use { handle ->
            val visible = setOf(JitenReaderAction.Again, JitenReaderAction.Good)
            val customDue = JitenStateStyle(
                textEnabled = false,
                backgroundEnabled = true,
                textColor = 0xFF123456,
                backgroundColor = 0x80112233,
            )

            handle.repository.update { settings ->
                settings.copy(
                    visibleActions = visible,
                    stateStyles = settings.stateStyles + (JitenCardState.Due to customDue),
                )
            }

            val saved = handle.repository.settings.first()
            assertEquals(visible, saved.visibleActions)
            assertEquals(customDue, saved.stateStyles[JitenCardState.Due])
        }
    }

    private fun repository(): RepositoryHandle {
        val scope = CoroutineScope(Dispatchers.IO + Job())
        val dataStore = PreferenceDataStoreFactory.create(
            scope = scope,
            produceFile = { File(tempFolder.root, "jiten-settings.preferences_pb") },
        )
        return RepositoryHandle(DataStoreJitenSettingsRepository(dataStore), scope)
    }

    private class RepositoryHandle(
        val repository: DataStoreJitenSettingsRepository,
        private val scope: CoroutineScope,
    ) : AutoCloseable {
        override fun close() {
            scope.cancel()
        }
    }
}
