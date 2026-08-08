package moe.antimony.hoshi.features.jiten

import android.webkit.JavascriptInterface
import android.webkit.WebView
import kotlinx.serialization.json.Json

/**
 * The whole surface upstream reader files call into for Jiten.
 *
 * Reader code owns none of the protocol: it installs the bridge, forwards parse
 * requests to whoever can answer them, and drops the bridge on release.
 */
internal const val JitenReaderBridgeName = "HoshiJiten"

private class JitenReaderBridge(
    private val webView: WebView,
    private val onParseRequested: (Int, String) -> Unit,
) {
    @JavascriptInterface
    fun parse(requestId: Int, paragraphsJson: String) {
        webView.post { onParseRequested(requestId, paragraphsJson) }
    }
}

internal fun WebView.installJitenReaderBridge(onParseRequested: (WebView, Int, String) -> Unit) {
    addJavascriptInterface(
        JitenReaderBridge(this) { requestId, paragraphsJson ->
            onParseRequested(this, requestId, paragraphsJson)
        },
        JitenReaderBridgeName,
    )
}

internal fun WebView.removeJitenReaderBridge() {
    removeJavascriptInterface(JitenReaderBridgeName)
}

internal fun WebView.applyJitenReaderTokens(requestId: Int, tokensJson: String) {
    evaluateJavascript(jitenReaderTokensInvocation(requestId, tokensJson), null)
}

/**
 * The guard matters: the reader scripts are always injected, but the visual
 * novel runtime never defines the controller.
 */
internal fun jitenReaderTokensInvocation(requestId: Int, tokensJson: String): String =
    "if (window.hoshiReaderJiten) { window.hoshiReaderJiten.onTokens($requestId, " +
        "${Json.encodeToString(tokensJson)}); }"

internal fun jitenReaderStartInvocation(): String =
    "if (window.hoshiReaderJiten) { window.hoshiReaderJiten.start(); }"

/**
 * The reader scripts, ready to append to the shell script. They are injected
 * whether or not Jiten is switched on: the controller does nothing until the
 * bridge answers, and gating the injection would mean threading the setting
 * through every layer that builds the script.
 */
internal fun jitenReaderScripts(
    paragraphsJs: String,
    highlightJs: String,
    controllerJs: String,
    css: String,
): String = listOf(
    paragraphsJs,
    highlightJs.replace("__HOSHI_JITEN_CSS_LITERAL__", Json.encodeToString(css)),
    controllerJs,
).joinToString(separator = "\n")
