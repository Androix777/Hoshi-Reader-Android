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
            assertEquals(JitenReaderAction.entries.toSet(), handle.repository.settings.first().visibleActions)
        }
    }

    @Test
    fun hiddenActionsArePersisted() = runBlocking {
        repository().use { handle ->
            val visible = setOf(JitenReaderAction.Again, JitenReaderAction.Good)

            handle.repository.update { settings -> settings.copy(visibleActions = visible) }

            assertEquals(visible, handle.repository.settings.first().visibleActions)
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
