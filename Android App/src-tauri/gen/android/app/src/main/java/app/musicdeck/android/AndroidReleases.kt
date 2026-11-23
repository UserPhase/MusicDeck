package app.musicdeck.android

import java.net.URI
import javax.net.ssl.HttpsURLConnection
import org.json.JSONArray

internal const val ANDROID_RELEASES_URL = "https://github.com/UserPhase/MusicDeck/releases"
private const val RELEASES_API = "https://api.github.com/repos/UserPhase/MusicDeck/releases?per_page=100"
private val VERSION = Regex("""(\d+)\.(\d+)\.(\d+)""")
private val SHA256 = Regex("""sha256:([0-9a-f]{64})""", RegexOption.IGNORE_CASE)
private val ABI_FLAVORS = mapOf("arm64-v8a" to "arm64", "armeabi-v7a" to "arm", "x86_64" to "x86_64", "x86" to "x86")

private data class Version(val major: Int, val minor: Int, val patch: Int) : Comparable<Version> {
    override fun compareTo(other: Version): Int = compareValuesBy(this, other, Version::major, Version::minor, Version::patch)

    companion object {
        fun parse(value: String): Version? {
            val match = VERSION.matchEntire(value) ?: return null
            val major = match.groupValues[1].toIntOrNull() ?: return null
            val minor = match.groupValues[2].toIntOrNull() ?: return null
            val patch = match.groupValues[3].toIntOrNull() ?: return null
            return Version(major, minor, patch)
        }
    }
}

internal data class AndroidRelease(val tag: String, val apk: AndroidApk) {
    val versionLabel: String get() = tag.removePrefix("android-")
}

internal data class AndroidApk(val url: URI, val size: Long, val sha256: String)

internal fun findAndroidUpdate(
    installedVersion: String, releases: JSONArray, abis: List<String>, buildType: String,
): AndroidRelease? {
    val installed = Version.parse(installedVersion.removeSuffix("-preview")) ?: return null
    if (buildType !in listOf("debug", "release")) return null
    val apkNames = (abis.mapNotNull(ABI_FLAVORS::get) + "universal").map { "app-$it-$buildType.apk" }
    val updates = (0 until releases.length()).asSequence().mapNotNull { index ->
        val release = releases.optJSONObject(index) ?: return@mapNotNull null
        val tag = release.optString("tag_name")
        if (release.optBoolean("draft") || !tag.startsWith("android-")) return@mapNotNull null
        val version = Version.parse(tag.removePrefix("android-").removeSuffix("-preview")) ?: return@mapNotNull null
        if (version <= installed) return@mapNotNull null
        val assets = release.optJSONArray("assets") ?: return@mapNotNull null
        val apk = (0 until assets.length()).asSequence().mapNotNull asset@{ assetIndex ->
            val asset = assets.optJSONObject(assetIndex) ?: return@asset null
            val name = asset.optString("name")
            val rank = apkNames.indexOf(name)
            if (rank < 0 || asset.optString("state") != "uploaded") return@asset null
            val size = asset.optLong("size")
            if (size <= 0) return@asset null
            val digest = SHA256.matchEntire(asset.optString("digest")) ?: return@asset null
            val url = URI.create("$ANDROID_RELEASES_URL/download/$tag/$name")
            rank to AndroidApk(url, size, digest.groupValues[1])
        }.minByOrNull { it.first }?.second ?: return@mapNotNull null
        version to AndroidRelease(tag, apk)
    }
    return updates.maxWithOrNull(compareBy({ it.first }, { !it.second.tag.endsWith("-preview") }))?.second
}

internal fun checkForAndroidUpdate(installedVersion: String, abis: List<String>, buildType: String): AndroidRelease? {
    val request = URI.create(RELEASES_API).toURL().openConnection() as HttpsURLConnection
    return try {
        request.connectTimeout = 5_000
        request.readTimeout = 5_000
        request.useCaches = false
        request.instanceFollowRedirects = false
        request.setRequestProperty("Accept", "application/vnd.github+json")
        request.setRequestProperty("User-Agent", "MusicDeck-Android/$installedVersion")
        if (request.responseCode != 200) return null
        val releases = request.inputStream.bufferedReader(Charsets.UTF_8).use { JSONArray(it.readText()) }
        findAndroidUpdate(installedVersion, releases, abis, buildType)
    } finally {
        request.disconnect()
    }
}
