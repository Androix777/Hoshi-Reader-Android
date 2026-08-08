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

/**
 * What the controller asks of Kotlin. Request ids are opaque strings, unique
 * per page load, and are echoed back untouched.
 */
internal interface JitenReaderRequests {
    fun beginSession(sessionId: String)
    fun parse(requestId: String, paragraphsJson: String)
    fun cancel(requestId: String)
}

/** For reader previews and tests, which have no view model to answer with. */
internal object NoJitenReaderRequests : JitenReaderRequests {
    override fun beginSession(sessionId: String) = Unit
    override fun parse(requestId: String, paragraphsJson: String) = Unit
    override fun cancel(requestId: String) = Unit
}

private class JitenReaderBridge(
    private val webView: WebView,
    private val requests: (WebView) -> JitenReaderRequests,
) {
    @JavascriptInterface
    fun beginSession(sessionId: String) {
        webView.post { requests(webView).beginSession(sessionId) }
    }

    @JavascriptInterface
    fun parse(requestId: String, paragraphsJson: String) {
        webView.post { requests(webView).parse(requestId, paragraphsJson) }
    }

    @JavascriptInterface
    fun cancel(requestId: String) {
        webView.post { requests(webView).cancel(requestId) }
    }
}

internal fun WebView.installJitenReaderBridge(requests: (WebView) -> JitenReaderRequests) {
    addJavascriptInterface(JitenReaderBridge(this, requests), JitenReaderBridgeName)
}

internal fun WebView.removeJitenReaderBridge() {
    removeJavascriptInterface(JitenReaderBridgeName)
}

/** Ties the controller's requests to a view model and the WebView that asked. */
internal fun jitenReaderRequests(
    viewModel: JitenReaderViewModel,
    webView: WebView,
): JitenReaderRequests = object : JitenReaderRequests {
    override fun beginSession(sessionId: String) = viewModel.beginSession(sessionId)

    override fun parse(requestId: String, paragraphsJson: String) =
        viewModel.parse(
            requestId = requestId,
            paragraphsJson = paragraphsJson,
            onTokens = { tokensJson -> webView.applyJitenReaderTokens(requestId, tokensJson) },
            onFailed = { webView.failJitenReaderRequest(requestId) },
        )

    override fun cancel(requestId: String) = viewModel.cancel(requestId)
}

internal fun WebView.applyJitenReaderTokens(requestId: String, tokensJson: String) {
    evaluateJavascript(jitenReaderTokensInvocation(requestId, tokensJson), null)
}

internal fun WebView.failJitenReaderRequest(requestId: String) {
    evaluateJavascript(jitenReaderFailureInvocation(requestId), null)
}

internal fun jitenReaderFailureInvocation(requestId: String): String =
    "if (window.hoshiReaderJiten) { window.hoshiReaderJiten.onFailed(" +
        "${Json.encodeToString(requestId)}); }"

/**
 * The guard matters: the reader scripts are always injected, but the visual
 * novel runtime never defines the controller.
 */
internal fun jitenReaderTokensInvocation(requestId: String, tokensJson: String): String =
    "if (window.hoshiReaderJiten) { window.hoshiReaderJiten.onTokens(" +
        "${Json.encodeToString(requestId)}, ${Json.encodeToString(tokensJson)}); }"

internal fun jitenReaderStartInvocation(): String =
    "if (window.hoshiReaderJiten) { window.hoshiReaderJiten.start(); }"

/** Repaints a reviewed word wherever the chapter shows it. */
internal fun WebView.updateJitenReaderStates(key: JitenWordKey, states: List<String>) {
    evaluateJavascript(jitenReaderStatesInvocation(key, states), null)
}

/** The state names as the popup receives them. */
internal fun jitenStatesJson(states: List<String>): String = Json.encodeToString(states)

internal fun jitenReaderStatesInvocation(key: JitenWordKey, states: List<String>): String =
    "if (window.hoshiReaderJitenHighlight) { window.hoshiReaderJitenHighlight.updateStates(" +
        "${key.wordId}, ${key.readingIndex}, ${Json.encodeToString(states)}); }"

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
    tapJs: String,
    css: String,
): String = listOf(
    paragraphsJs,
    highlightJs.replace("__HOSHI_JITEN_CSS_LITERAL__", Json.encodeToString(css)),
    controllerJs,
    // After the highlight module, whose attributes it reads. Order is only
    // legibility: nothing here runs until a tap.
    tapJs,
).joinToString(separator = "\n")
