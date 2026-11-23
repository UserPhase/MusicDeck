package app.musicdeck.android

import android.app.Activity
import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import androidx.appcompat.app.AlertDialog

class MusicDeckApplication : Application(), Application.ActivityLifecycleCallbacks {
    private val main = Handler(Looper.getMainLooper())
    private var started = false
    private var checking = false
    private var resumedActivity: Activity? = null
    private var pendingUpdate: AndroidRelease? = null
    private var updatePrompt: AlertDialog? = null
    private var permissionUpdate: AndroidRelease? = null
    private var installing = false
    private var downloadPrompt: AlertDialog? = null
    private var confirmation: Pair<Int, Intent>? = null

    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(this)
    }

    internal fun checkForUpdates() {
        if (checking || updatePrompt != null || installing || permissionUpdate != null || confirmation != null) return
        pendingUpdate = null
        checking = true
        Thread({
            val update = runCatching {
                checkForAndroidUpdate(BuildConfig.VERSION_NAME, Build.SUPPORTED_ABIS.toList(), BuildConfig.BUILD_TYPE)
            }.getOrNull()
            main.post {
                checking = false
                pendingUpdate = update
                showUpdateWhenReady()
            }
        }, "MusicDeck update check").start()
    }

    private fun showUpdateWhenReady() {
        val activity = resumedActivity ?: return
        val update = pendingUpdate ?: return
        if (activity.isFinishing || activity.isDestroyed || updatePrompt != null || installing || permissionUpdate != null) return
        pendingUpdate = null
        val prompt = AlertDialog.Builder(activity)
            .setTitle("MusicDeck update available")
            .setMessage("MusicDeck ${update.versionLabel} is available for Android.")
            .setNegativeButton("Later", null)
            .setPositiveButton("Update") { _, _ -> requestInstall(activity, update) }
            .create()
        prompt.setOwnerActivity(activity)
        prompt.setOnDismissListener { updatePrompt = null }
        updatePrompt = prompt
        prompt.show()
    }

    private fun canInstall(): Boolean = Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()

    private fun requestInstall(activity: Activity, update: AndroidRelease) {
        if (canInstall()) {
            startDownload(activity, update)
            return
        }
        permissionUpdate = update
        try {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.fromParts("package", packageName, null)))
            announce("Allow MusicDeck to install updates, then return to the app.")
        } catch (_: ActivityNotFoundException) {
            permissionUpdate = null
            announce("Android couldn't open the app installation settings.")
        } catch (_: SecurityException) {
            permissionUpdate = null
            announce("Android blocks MusicDeck from requesting app installs on this device.")
        }
    }

    private fun startDownload(activity: Activity, update: AndroidRelease) {
        if (installing) return
        installing = true
        downloadPrompt = AlertDialog.Builder(activity)
            .setTitle("Downloading MusicDeck ${update.versionLabel}")
            .setMessage("You can keep using MusicDeck while the update downloads.")
            .setPositiveButton("Continue in background", null)
            .create().also { prompt ->
                prompt.setOwnerActivity(activity)
                prompt.setOnDismissListener { downloadPrompt = null }
                prompt.show()
            }

        Thread({
            val result = runCatching { installAndroidUpdate(this, update.apk) }
            main.post {
                downloadPrompt?.dismiss()
                if (result.isFailure) {
                    installing = false
                    announce("Couldn't prepare the MusicDeck update. Check your connection and free space, then try again.")
                }
            }
        }, "MusicDeck update download").start()
    }

    @Suppress("DEPRECATION")
    internal fun onUpdateStatus(result: Intent) {
        downloadPrompt?.dismiss()
        val status = result.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val sessionId = result.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
            val request = if (Build.VERSION.SDK_INT >= 33) result.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                else result.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
            if (request != null) {
                installing = true
                confirmation = sessionId to request
                showInstallConfirmation()
                return
            }
            runCatching { packageManager.packageInstaller.abandonSession(sessionId) }
        }
        installing = false
        confirmation = null
        when (status) {
            PackageInstaller.STATUS_SUCCESS, PackageInstaller.STATUS_FAILURE_ABORTED -> Unit
            PackageInstaller.STATUS_FAILURE_STORAGE -> announce("Free up space to install the MusicDeck update.")
            PackageInstaller.STATUS_FAILURE_CONFLICT -> announce("Android couldn't replace MusicDeck. Updates must use the same signing key.")
            else -> announce("Android couldn't install the MusicDeck update. Try again on the next launch.")
        }
    }

    private fun showInstallConfirmation() {
        val activity = resumedActivity ?: return
        if (activity.isFinishing || activity.isDestroyed) return
        val (sessionId, request) = confirmation ?: return
        confirmation = null
        try {
            activity.startActivity(request)
        } catch (_: ActivityNotFoundException) {
            installing = false
            runCatching { packageManager.packageInstaller.abandonSession(sessionId) }
            announce("Android couldn't open the system installer.")
        } catch (_: SecurityException) {
            installing = false
            runCatching { packageManager.packageInstaller.abandonSession(sessionId) }
            announce("Android couldn't open the system installer.")
        }
    }

    private fun announce(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        if (!started || (activity is MainActivity && savedInstanceState == null)) {
            started = true
            checkForUpdates()
        }
    }

    override fun onActivityResumed(activity: Activity) {
        resumedActivity = activity
        permissionUpdate?.let { update ->
            permissionUpdate = null
            if (canInstall()) startDownload(activity, update)
            else announce("MusicDeck can try the update again the next time you launch it.")
        }
        showInstallConfirmation()
        showUpdateWhenReady()
    }

    override fun onActivityPaused(activity: Activity) {
        if (resumedActivity === activity) resumedActivity = null
    }

    override fun onActivityDestroyed(activity: Activity) {
        if (updatePrompt?.ownerActivity === activity) updatePrompt?.dismiss()
        if (downloadPrompt?.ownerActivity === activity) downloadPrompt?.dismiss()
    }

    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
}
