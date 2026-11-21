package app.musicdeck.android

import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URL
import java.net.UnknownHostException
import javax.net.ssl.SSLException

private const val TIMEOUT_MS = 4000
private const val MAX_CONFIG_BYTES = 4096

private fun <T> get(url: URL, accept: String, read: (HttpURLConnection) -> T): T {
    val connection = url.openConnection() as HttpURLConnection
    try {
        connection.instanceFollowRedirects = false
        connection.connectTimeout = TIMEOUT_MS
        connection.readTimeout = TIMEOUT_MS
        connection.useCaches = false
        connection.setRequestProperty("Accept", accept)
        if (connection.responseCode in 300..399) {
            throw IOException("The server redirects this address. Enter the final MusicDeck gateway URL.")
        }
        return read(connection)
    } finally {
        connection.disconnect()
    }
}

internal fun checkMusicDeckGateway(serverUrl: String): String? {
    val gateway = URI(serverUrl)
    return try {
        val configError = get(gateway.resolve("/api/public/config").toURL(), "application/json") { response ->
            when {
                response.responseCode !in 200..299 ->
                    "MusicDeck's API returned HTTP ${response.responseCode}. Check the gateway URL and its proxy."
                response.contentType?.substringBefore(';')?.trim() != "application/json" ->
                    "This address did not return MusicDeck's API configuration. Check the gateway URL and port."
                else -> {
                    val bytes = ByteArray(MAX_CONFIG_BYTES + 1)
                    var length = 0
                    response.inputStream.use { input ->
                        while (length < bytes.size) {
                            val count = input.read(bytes, length, bytes.size - length)
                            if (count == -1) break
                            length += count
                        }
                    }
                    val name = if (length <= MAX_CONFIG_BYTES) {
                        JSONObject(String(bytes, 0, length, Charsets.UTF_8)).opt("appName") as? String
                    } else null
                    if (name.isNullOrBlank()) "This address did not return MusicDeck's API configuration." else null
                }
            }
        }
        configError ?: get(gateway.toURL(), "text/html") { response ->
            if (response.responseCode !in 200..299 ||
                !response.contentType.orEmpty().startsWith("text/html", ignoreCase = true)
            ) {
                "The API responded, but the web app was unavailable. Enter the MusicDeck web gateway URL (usually port 8080 for Docker Compose)."
            } else null
        }
    } catch (_: UnknownHostException) {
        "Could not find '${gateway.host}'. Check the hostname or enter the server's LAN IP."
    } catch (_: SocketTimeoutException) {
        "The server timed out. Check the URL, port, and that your phone can reach the server."
    } catch (_: SSLException) {
        "Android could not verify the gateway's HTTPS connection. Check its certificate and hostname."
    } catch (_: JSONException) {
        "The server returned an invalid MusicDeck API configuration."
    } catch (error: IOException) {
        error.message?.takeIf { it.startsWith("The server redirects") }
            ?: "Could not reach $serverUrl. Check the port, Wi-Fi, firewall, and Local network permission."
    }
}
