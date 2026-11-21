package app.musicdeck.android

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

// The gateway runs as a normal web app, with its own cookies and no Tauri bridge.
class ServerActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var gateway: Uri
    private var connectivityManager: ConnectivityManager? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileCallback
        fileCallback = null
        callback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
    }
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            runOnUiThread {
                if (!isDestroyed) {
                    webView.evaluateJavascript("window.dispatchEvent(new Event('musicdeck:android-network-available'))", null)
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val server = intent.data
        if (server == null) {
            finish()
            return
        }
        gateway = server
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.userAgentString += " MusicDeckAndroid"
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url
                    if (request.isForMainFrame && url == Uri.parse("https://tauri.localhost/")) {
                        finish()
                        return true
                    }
                    return request.isForMainFrame && !isGatewayOrigin(url)
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams,
                ): Boolean {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = callback
                    try {
                        fileChooser.launch(params.createIntent())
                    } catch (_: ActivityNotFoundException) {
                        fileCallback = null
                        callback.onReceiveValue(null)
                    }
                    return true
                }
            }
        }
        setContentView(webView)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(gateway.toString())
        }
        connectivityManager = getSystemService(ConnectivityManager::class.java)?.also {
            it.registerDefaultNetworkCallback(networkCallback)
        }
    }

    private fun isGatewayOrigin(url: Uri): Boolean =
        url.scheme == gateway.scheme && url.host.equals(gateway.host, ignoreCase = true) &&
            effectivePort(url) == effectivePort(gateway) && url.userInfo == null

    private fun effectivePort(url: Uri): Int =
        if (url.port != -1) url.port else if (url.scheme == "https") 443 else 80

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) webView.onResume()
    }

    override fun onPause() {
        if (::webView.isInitialized) webView.onPause()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::webView.isInitialized) webView.saveState(outState)
    }

    override fun onDestroy() {
        connectivityManager?.unregisterNetworkCallback(networkCallback)
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        if (::webView.isInitialized) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }
}
