package app.musicdeck.android

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build

internal fun installAndroidUpdate(context: Context, apk: AndroidApk) {
    val installer = context.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
        setAppPackageName(context.packageName)
        setSize(apk.size)
        if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
    }
    val sessionId = installer.createSession(params)
    var committed = false
    var callback: PendingIntent? = null
    try {
        installer.openSession(sessionId).use { session ->
            session.openWrite("base.apk", 0, apk.size).use { output ->
                downloadAndroidApk(apk, output)
                session.fsync(output)
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val receiver = Intent(context, AndroidUpdateReceiver::class.java)
            val status = PendingIntent.getBroadcast(context, sessionId, receiver, flags)
            callback = status
            session.commit(status.intentSender)
            committed = true
        }
    } finally {
        if (!committed) {
            callback?.cancel()
            runCatching { installer.abandonSession(sessionId) }
        }
    }
}

class AndroidUpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!intent.hasExtra(PackageInstaller.EXTRA_STATUS)) return
        (context.applicationContext as MusicDeckApplication).onUpdateStatus(intent)
    }
}
