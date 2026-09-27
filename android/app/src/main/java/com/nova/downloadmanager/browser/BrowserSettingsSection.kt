package com.nova.downloadmanager.browser

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nova.downloadmanager.R
import com.nova.downloadmanager.design.NOVADimens

/**
 * Browser controls deliberately keep two privacy boundaries visible in code:
 * user scripts are disabled until an explicit local opt-in, and DNS profiles
 * are preferences only until a separately consented private-routing service
 * exists. Neither setting changes system-wide device networking.
 */
@Composable
fun BrowserSettingsSection(
    modifier: Modifier = Modifier,
    browserViewModel: BrowserViewModel = viewModel(),
) {
    val state by browserViewModel.uiState.collectAsState()
    var scriptName by rememberSaveable { mutableStateOf("") }
    var scriptHost by rememberSaveable { mutableStateOf("") }
    var scriptSource by rememberSaveable { mutableStateOf("") }

    Column(
        modifier = modifier.padding(
            horizontal = NOVADimens.ScreenHorizontal,
            vertical = NOVADimens.Section,
        ),
        verticalArrangement = Arrangement.spacedBy(NOVADimens.ItemGap),
    ) {
        Text(
            text = stringResource(R.string.nova_browser_script_group),
            style = MaterialTheme.typography.headlineSmall,
        )
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(NOVADimens.CompactGap),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = stringResource(R.string.nova_browser_script_group),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Switch(
                        checked = state.userScriptsEnabled,
                        onCheckedChange = browserViewModel::setUserScriptsEnabled,
                    )
                }
                if (state.userScriptsEnabled) {
                    OutlinedTextField(
                        value = scriptName,
                        onValueChange = { scriptName = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text(stringResource(R.string.nova_browser_script_name)) },
                        singleLine = true,
                    )
                    OutlinedTextField(
                        value = scriptHost,
                        onValueChange = { scriptHost = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text(stringResource(R.string.nova_browser_script_match)) },
                        singleLine = true,
                    )
                    OutlinedTextField(
                        value = scriptSource,
                        onValueChange = { scriptSource = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text(stringResource(R.string.nova_browser_script_source)) },
                        minLines = 4,
                    )
                    Button(
                        onClick = {
                            if (browserViewModel.addUserScript(scriptName, scriptHost, scriptSource)) {
                                scriptName = ""
                                scriptHost = ""
                                scriptSource = ""
                            }
                        },
                        enabled = UserScriptPolicy.validate(scriptName, scriptHost, scriptSource) == UserScriptValidation.Valid,
                    ) {
                        Text(stringResource(R.string.nova_action_save))
                    }
                }
                state.scripts.forEach { script ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(script.name, style = MaterialTheme.typography.bodyMedium)
                        Button(onClick = { browserViewModel.removeUserScript(script.id) }) {
                            Text(stringResource(R.string.nova_action_remove))
                        }
                    }
                }
            }
        }

        Text(
            text = stringResource(R.string.nova_dns_configuration),
            style = MaterialTheme.typography.headlineSmall,
        )
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(NOVADimens.CompactGap),
            ) {
                Text(
                    text = stringResource(R.string.nova_dns_system_default),
                    style = MaterialTheme.typography.bodyMedium,
                )
                DnsPrivacyProfile.entries.forEach { profile ->
                    FilterChip(
                        selected = state.dnsProfile == profile,
                        onClick = { browserViewModel.setDnsProfile(profile) },
                        label = {
                            Text(
                                text = when (profile) {
                                    DnsPrivacyProfile.System -> stringResource(R.string.nova_dns_system_default)
                                    DnsPrivacyProfile.Custom -> stringResource(R.string.nova_dns_custom)
                                    else -> profile.name
                                },
                            )
                        },
                    )
                }
                if (state.dnsProfile == DnsPrivacyProfile.Custom) {
                    OutlinedTextField(
                        value = state.customDnsEndpoint,
                        onValueChange = browserViewModel::setCustomDnsEndpoint,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text(stringResource(R.string.nova_dns_custom_label)) },
                        isError = state.customDnsEndpoint.isNotBlank() && !browserViewModel.hasValidCustomDnsEndpoint(),
                        singleLine = true,
                    )
                }
            }
        }

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
        ) {
            Text(
                text = stringResource(R.string.nova_security_privacy),
                modifier = Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}
