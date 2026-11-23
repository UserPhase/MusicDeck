package app.musicdeck.android

import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override val handleBackNavigation = true
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (intent.action == Intent.ACTION_MAIN && intent.hasCategory(Intent.CATEGORY_LAUNCHER)) {
      (application as MusicDeckApplication).checkForUpdates()
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.settings.userAgentString += " MusicDeckAndroid"
  }
}
