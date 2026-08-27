package com.nova.downloadmanager.browser

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.runtime.collectAsState
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nova.downloadmanager.R
import com.nova.downloadmanager.design.NOVADimens
import java.io.ByteArrayInputStream

/**
 * Lightweight first-party browser surface for collecting ordinary HTTP(S)
 * download links. Transfer bytes are never handled here: a captured link is
 * handed to the NOVA download review flow so user intent remains explicit.
 */
@Composable
fun BrowserScreen(
    onDownloadCaptured: (String) -> Unit,
    modifier: Modifier = Modifier,
    browserViewModel: BrowserViewModel = viewModel(),
) {
    val browserState by browserViewModel.uiState.collectAsState()
    val latestBrowserState = rememberUpdatedState(browserState)
    var address by rememberSaveable { mutableStateOf("") }
    var currentUrl by rememberSaveable { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(false) }
    var rendererGeneration by rememberSaveable { mutableIntStateOf(0) }
    var navigationRejected by remember { mutableStateOf(false) }
    var webView by remember { mutableStateOf<WebView?>(null) }

    DisposableEffect(Unit) {
        onDispose {
            webView?.apply {
                stopLoading()
                loadUrl("about:blank")
                destroy()
            }
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = NOVADimens.ScreenHorizontal, vertical = NOVADimens.ItemGap),
        verticalArrangement = Arrangement.spacedBy(NOVADimens.ItemGap),
    ) {
        Text(
            text = stringResource(R.string.nova_browser_title),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            text = stringResource(R.string.nova_browser_detail),
            style = MaterialTheme.typography.bodyMedium,
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(NOVADimens.CompactGap),
        ) {
            OutlinedTextField(
                value = address,
                onValueChange = {
                    address = it
                    navigationRejected = false
                },
                modifier = Modifier.weight(1f),
                label = { Text(stringResource(R.string.nova_browser_address)) },
                singleLine = true,
                isError = navigationRejected,
            )
            Button(
                onClick = {
                    val normalized = BrowserUrlPolicy.normalizeTypedAddress(address)
                    if (normalized == null) {
                        navigationRejected = true
                    } else {
                        address = normalized
                        currentUrl = normalized
                        navigationRejected = false
                    }
                },
            ) {
                Text(stringResource(R.string.nova_action_apply))
            }
        }
        if (navigationRejected) {
            Text(
                text = stringResource(R.string.nova_browser_invalid_url),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(NOVADimens.CompactGap)) {
            FilterChip(
                selected = browserState.cleanBrowsingEnabled,
                onClick = { browserViewModel.setCleanBrowsingEnabled(!browserState.cleanBrowsingEnabled) },
                label = { Text(stringResource(R.string.nova_browser_clean_browsing)) },
            )
            FilterChip(
                selected = browserState.captureEnabled,
                onClick = { browserViewModel.setCaptureEnabled(!browserState.captureEnabled) },
                label = { Text(stringResource(R.string.nova_browser_capture)) },
            )
        }

        if (isLoading) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }

        Card(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f, fill = true)
                .heightIn(min = 240.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            key(rendererGeneration) {
                BrowserWebView(
                    currentUrl = currentUrl,
                    stateProvider = { latestBrowserState.value },
                    onCreated = { webView = it },
                    onLoadingChanged = { isLoading = it },
                    onNavigationRejected = { navigationRejected = true },
                    onRendererGone = {
                        currentUrl = ""
                        rendererGeneration += 1
                    },
                    onDownloadCaptured = onDownloadCaptured,
                )
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun BrowserWebView(
    currentUrl: String,
    stateProvider: () -> BrowserUiState,
    onCreated: (WebView) -> Unit,
    onLoadingChanged: (Boolean) -> Unit,
    onNavigationRejected: () -> Unit,
    onRendererGone: () -> Unit,
    onDownloadCaptured: (String) -> Unit,
) {
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { context ->
            WebView(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.javaScriptCanOpenWindowsAutomatically = false
                settings.setSupportMultipleWindows(false)
                settings.safeBrowsingEnabled = true
                // No addJavascriptInterface: untrusted page content never gains
                // a bridge to Android or NOVA internals.
                webViewClient = NovaWebViewClient(
                    initialState = stateProvider,
                    onLoadingChanged = onLoadingChanged,
                    onNavigationRejected = onNavigationRejected,
                    onRendererGone = onRendererGone,
                )
                setDownloadListener { url, _, _, _, _ ->
                    if (stateProvider().captureEnabled) {
                        BrowserUrlPolicy.normalizeHttpUrl(url)?.let(onDownloadCaptured)
                    }
                }
                onCreated(this)
                loadUrl("about:blank")
            }
        },
        update = { webView ->
            if (currentUrl.isNotBlank() && currentUrl != webView.url) {
                webView.loadUrl(currentUrl)
            }
        },
    )
}

private class NovaWebViewClient(
    private val initialState: () -> BrowserUiState,
    private val onLoadingChanged: (Boolean) -> Unit,
    private val onNavigationRejected: () -> Unit,
    private val onRendererGone: () -> Unit,
) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (!request.isForMainFrame) return false
        if (!BrowserUrlPolicy.isSafeTopLevelUrl(request.url.toString())) {
            onNavigationRejected()
            return true
        }
        return false
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        if (initialState().cleanBrowsingEnabled && BrowserUrlPolicy.isBlockedRequest(request.url.toString())) {
            return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
        }
        return super.shouldInterceptRequest(view, request)
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        onLoadingChanged(true)
        super.onPageStarted(view, url, favicon)
    }

    override fun onPageFinished(view: WebView, url: String) {
        val state = initialState()
        if (state.userScriptsEnabled) {
            state.scripts.filter { it.enabled && UserScriptPolicy.matches(it, url) }.forEach { script ->
                view.evaluateJavascript(UserScriptPolicy.wrappedSource(script), null)
            }
        }
        onLoadingChanged(false)
        super.onPageFinished(view, url)
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        onLoadingChanged(false)
        onRendererGone()
        return true
    }
}
