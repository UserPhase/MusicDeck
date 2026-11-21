package app.musicdeck.android

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.annotation.Keep
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@Keep
@TauriPlugin(permissions = [Permission(strings = ["android.permission.ACCESS_LOCAL_NETWORK"], alias = "localNetwork")])
class LocalNetworkPlugin(private val host: Activity) : Plugin(host) {
    @InvokeArg
    class ServerArgs {
        lateinit var url: String
        var open: Boolean = false
    }

    @Command
    fun allowLocalNetwork(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < 37 || getPermissionState("localNetwork") == PermissionState.GRANTED) {
            invoke.resolveObject(true)
        } else {
            requestPermissionForAlias("localNetwork", invoke, "localNetworkResult")
        }
    }

    @PermissionCallback
    fun localNetworkResult(invoke: Invoke) {
        invoke.resolveObject(getPermissionState("localNetwork") == PermissionState.GRANTED)
    }

    @Command
    fun checkServer(invoke: Invoke) {
        val args = invoke.parseArgs(ServerArgs::class.java)
        Thread {
            val failure = checkMusicDeckGateway(args.url)
            host.runOnUiThread {
                if (failure != null) {
                    invoke.reject(failure)
                } else if (host.isDestroyed || host.isFinishing) {
                    invoke.reject("Reopen MusicDeck and try again.")
                } else {
                    if (args.open) {
                        val intent = Intent(host, ServerActivity::class.java)
                            .setData(Uri.parse(args.url))
                        host.startActivity(intent)
                    }
                    invoke.resolve()
                }
            }
        }.start()
    }

    @Command
    fun openReleases(invoke: Invoke) {
        host.runOnUiThread {
            val page = Uri.parse("https://github.com/UserPhase/MusicDeck/releases")
            try {
                host.startActivity(Intent(Intent.ACTION_VIEW, page))
                invoke.resolve()
            } catch (_: ActivityNotFoundException) {
                invoke.reject("Open github.com/UserPhase/MusicDeck/releases in a browser to check for an Android APK.")
            }
        }
    }
}
