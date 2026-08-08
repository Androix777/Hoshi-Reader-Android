package moe.antimony.hoshi.features.jiten

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import moe.antimony.hoshi.R
import moe.antimony.hoshi.features.reader.ReaderColorPickerDialog
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
    var colorDialogTarget by remember { mutableStateOf<JitenColorTarget?>(null) }

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

    colorDialogTarget?.let { target ->
        val style = uiState.settings.styleFor(target.state)
        ReaderColorPickerDialog(
            title = stringResource(
                R.string.jiten_color_dialog_title,
                stringResource(target.state.labelRes),
                stringResource(target.channel.labelRes),
            ),
            initialColor = target.channel.color(style),
            defaultColor = target.channel.color(checkNotNull(DefaultJitenStateStyles[target.state])),
            onColorChange = { color ->
                viewModel.updateStateStyle(target.state) { current ->
                    target.channel.updated(current, color)
                }
                colorDialogTarget = null
            },
            onDismiss = { colorDialogTarget = null },
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
                            headlineContent = { Text(stringResource(R.string.jiten_word_colors)) },
                            supportingContent = { Text(stringResource(R.string.jiten_word_colors_description)) },
                        )
                        JitenCardState.entries.forEach { state ->
                            val style = uiState.settings.styleFor(state)
                            HorizontalDivider()
                            ListItem(
                                colors = ListItemDefaults.colors(
                                    containerColor = MaterialTheme.colorScheme.surface,
                                ),
                                headlineContent = { Text(stringResource(state.labelRes)) },
                            )
                            JitenStateColorRow(
                                label = stringResource(R.string.reader_appearance_text_color),
                                color = style.textColor,
                                enabled = style.textEnabled,
                                onEnabledChange = { enabled ->
                                    viewModel.updateStateStyle(state) {
                                        JitenColorChannel.Text.updatedEnabled(it, enabled)
                                    }
                                },
                                onColorClick = {
                                    colorDialogTarget = JitenColorTarget(state, JitenColorChannel.Text)
                                },
                            )
                            JitenStateColorRow(
                                label = stringResource(R.string.reader_appearance_background_color),
                                color = style.backgroundColor,
                                enabled = style.backgroundEnabled,
                                onEnabledChange = { enabled ->
                                    viewModel.updateStateStyle(state) {
                                        JitenColorChannel.Background.updatedEnabled(it, enabled)
                                    }
                                },
                                onColorClick = {
                                    colorDialogTarget = JitenColorTarget(state, JitenColorChannel.Background)
                                },
                            )
                        }
                    }
                }
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
                item {
                    JitenSettingsCard {
                        ListItem(
                            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
                            headlineContent = { Text(stringResource(R.string.jiten_card_actions)) },
                            supportingContent = { Text(stringResource(R.string.jiten_card_actions_description)) },
                        )
                        JitenReaderAction.entries.forEach { action ->
                            HorizontalDivider()
                            ListItem(
                                colors = ListItemDefaults.colors(
                                    containerColor = MaterialTheme.colorScheme.surface,
                                ),
                                headlineContent = { Text(stringResource(action.labelRes)) },
                                trailingContent = {
                                    Switch(
                                        checked = action in uiState.settings.visibleActions,
                                        onCheckedChange = { visible ->
                                            viewModel.updateActionVisible(action, visible)
                                        },
                                    )
                                },
                            )
                        }
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

private val JitenReaderAction.labelRes: Int
    get() = when (this) {
        JitenReaderAction.Again -> R.string.jiten_action_again
        JitenReaderAction.Hard -> R.string.jiten_action_hard
        JitenReaderAction.Good -> R.string.jiten_action_good
        JitenReaderAction.Easy -> R.string.jiten_action_easy
        JitenReaderAction.NeverForget -> R.string.jiten_action_never_forget
        JitenReaderAction.Blacklist -> R.string.jiten_action_blacklist
        JitenReaderAction.Forget -> R.string.jiten_action_forget
    }

private val JitenCardState.labelRes: Int
    get() = when (this) {
        JitenCardState.New -> R.string.jiten_state_new
        JitenCardState.Young -> R.string.jiten_state_young
        JitenCardState.Mature -> R.string.jiten_state_mature
        JitenCardState.Blacklisted -> R.string.jiten_state_blacklisted
        JitenCardState.Due -> R.string.jiten_state_due
        JitenCardState.Mastered -> R.string.jiten_state_mastered
        JitenCardState.Redundant -> R.string.jiten_state_redundant
        JitenCardState.Suspended -> R.string.jiten_state_suspended
    }

private data class JitenColorTarget(
    val state: JitenCardState,
    val channel: JitenColorChannel,
)

private enum class JitenColorChannel(val labelRes: Int) {
    Text(R.string.reader_appearance_text_color),
    Background(R.string.reader_appearance_background_color),
    ;

    fun color(style: JitenStateStyle): Long = when (this) {
        Text -> style.textColor
        Background -> style.backgroundColor
    }

    fun updated(style: JitenStateStyle, color: Long): JitenStateStyle = when (this) {
        Text -> style.copy(textColor = color)
        Background -> style.copy(backgroundColor = color)
    }

    fun updatedEnabled(style: JitenStateStyle, enabled: Boolean): JitenStateStyle = when (this) {
        Text -> style.copy(textEnabled = enabled)
        Background -> style.copy(backgroundEnabled = enabled)
    }
}

@Composable
private fun JitenStateColorRow(
    label: String,
    color: Long,
    enabled: Boolean,
    onEnabledChange: (Boolean) -> Unit,
    onColorClick: () -> Unit,
) {
    ListItem(
        modifier = Modifier.clickable(enabled = enabled, onClick = onColorClick),
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        headlineContent = { Text(label) },
        supportingContent = {
            Text(
                stringResource(
                    if (enabled) R.string.jiten_color_custom else R.string.jiten_color_reader_default,
                ),
            )
        },
        leadingContent = if (enabled) {
            {
                Surface(
                    modifier = Modifier.size(28.dp),
                    shape = RoundedCornerShape(14.dp),
                    color = Color(color),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    tonalElevation = 0.dp,
                ) {}
            }
        } else {
            null
        },
        trailingContent = {
            Switch(checked = enabled, onCheckedChange = onEnabledChange)
        },
    )
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
