package moe.antimony.hoshi.features.jiten

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.input.TextObfuscationMode
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedSecureTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import moe.antimony.hoshi.R
import moe.antimony.hoshi.features.settings.SettingsDetailScaffold
import moe.antimony.hoshi.ui.asString
import moe.antimony.hoshi.ui.hoshiOutlinedTextFieldColors
import moe.antimony.hoshi.ui.rememberSyncedTextFieldState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JitenSettingsView(
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val viewModel: JitenSettingsViewModel = hiltViewModel()
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    var editingApiKey by remember { mutableStateOf(false) }
    var apiKeyInput by remember { mutableStateOf("") }

    if (editingApiKey) {
        val apiKeyState = rememberSyncedTextFieldState(
            value = apiKeyInput,
            onValueChange = { apiKeyInput = it },
        )
        AlertDialog(
            onDismissRequest = { editingApiKey = false },
            title = { Text(stringResource(R.string.jiten_api_key)) },
            text = {
                Column {
                    OutlinedSecureTextField(
                        state = apiKeyState,
                        label = { Text(stringResource(R.string.jiten_api_key)) },
                        textObfuscationMode = TextObfuscationMode.Hidden,
                        colors = hoshiOutlinedTextFieldColors(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        text = stringResource(R.string.jiten_api_key_help),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.updateApiKey(apiKeyInput)
                        editingApiKey = false
                    },
                ) {
                    Text(stringResource(R.string.action_save))
                }
            },
            dismissButton = {
                TextButton(onClick = { editingApiKey = false }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }

    SettingsDetailScaffold(
        title = stringResource(R.string.settings_jiten),
        onClose = onClose,
        modifier = modifier,
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp),
        ) {
            item {
                JitenSettingsCard {
                    ListItem(
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                        headlineContent = { Text(stringResource(R.string.jiten_enable)) },
                        supportingContent = { Text(stringResource(R.string.jiten_enable_description)) },
                        trailingContent = {
                            Switch(
                                checked = uiState.settings.enabled,
                                onCheckedChange = viewModel::updateEnabled,
                            )
                        },
                    )
                }
            }
            if (uiState.settings.enabled) {
                item {
                    JitenSettingsCard {
                        ListItem(
                            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                            headlineContent = { Text(stringResource(R.string.jiten_api_key)) },
                            supportingContent = {
                                Text(
                                    if (uiState.settings.apiKey.isEmpty()) {
                                        stringResource(R.string.none)
                                    } else {
                                        stringResource(R.string.jiten_api_key_configured)
                                    },
                                )
                            },
                            trailingContent = {
                                TextButton(
                                    onClick = {
                                        apiKeyInput = uiState.settings.apiKey
                                        editingApiKey = true
                                    },
                                ) {
                                    Text(stringResource(R.string.action_edit))
                                }
                            },
                        )
                        HorizontalDivider()
                        ListItem(
                            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                            headlineContent = { Text(stringResource(R.string.jiten_connection)) },
                            supportingContent = {
                                Text(
                                    uiState.connectionMessage?.asString()
                                        ?: stringResource(uiState.connectionStatus.labelRes),
                                )
                            },
                            trailingContent = {
                                TextButton(
                                    onClick = viewModel::testConnection,
                                    enabled = !uiState.isTestingConnection,
                                ) {
                                    Text(
                                        if (uiState.isTestingConnection) {
                                            stringResource(R.string.jiten_connection_testing)
                                        } else {
                                            stringResource(R.string.action_connect)
                                        },
                                    )
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

private val JitenConnectionStatus.labelRes: Int
    get() = when (this) {
        JitenConnectionStatus.Unknown -> R.string.jiten_connection_untested
        JitenConnectionStatus.Connected -> R.string.jiten_connection_connected
        JitenConnectionStatus.Failed -> R.string.jiten_connection_failed
    }

@Composable
private fun JitenSettingsCard(content: @Composable () -> Unit) {
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 12.dp),
    ) {
        Column {
            content()
        }
    }
}
