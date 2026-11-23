package app.musicdeck.android

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection

private val DOWNLOAD_HOSTS = setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")

internal fun downloadAndroidApk(apk: AndroidApk, output: OutputStream) {
    var url = apk.url
    repeat(5) {
        if (url.scheme != "https" || url.host !in DOWNLOAD_HOSTS || url.userInfo != null || url.port !in listOf(-1, 443)) {
            throw IOException("Unexpected update download address.")
        }
        val request = url.toURL().openConnection() as HttpsURLConnection
        try {
            request.connectTimeout = 10_000
            request.readTimeout = 20_000
            request.useCaches = false
            request.instanceFollowRedirects = false
            request.setRequestProperty("User-Agent", "MusicDeck-Android")
            when (request.responseCode) {
                200 -> {
                    request.inputStream.use { copyVerifiedApk(apk, it, output) }
                    return
                }
                301, 302, 303, 307, 308 -> url = url.resolve(
                    request.getHeaderField("Location") ?: throw IOException("Missing update download address."),
                )
                else -> throw IOException("Update download returned HTTP ${request.responseCode}.")
            }
        } finally {
            request.disconnect()
        }
    }
    throw IOException("Too many update download redirects.")
}

internal fun copyVerifiedApk(apk: AndroidApk, input: InputStream, output: OutputStream) {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(64 * 1024)
    var size = 0L
    while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        size += count
        if (size > apk.size) throw IOException("Unexpected update download size.")
        digest.update(buffer, 0, count)
        output.write(buffer, 0, count)
    }
    val sha256 = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    if (size != apk.size || !sha256.equals(apk.sha256, ignoreCase = true)) {
        throw IOException("Update download verification failed.")
    }
}
