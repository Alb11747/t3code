package expo.modules.t3forkupdates

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.content.pm.PackageInfo
import android.net.Uri
import android.provider.Settings
import android.util.Base64
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

class T3ForkUpdatesModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)
  private val directory get() = File(context.filesDir, "fork-updates").apply { mkdirs() }
  private val preferences get() = context.getSharedPreferences("fork-updates", 0)

  @Suppress("DEPRECATION")
  private val signingFlags get() = if (Build.VERSION.SDK_INT >=
    28
  ) {
    PackageManager.GET_SIGNING_CERTIFICATES
  } else {
    PackageManager.GET_SIGNATURES
  }
  private val packageInfo get() = context.packageManager.getPackageInfo(
    context.packageName,
    signingFlags
  )

  @Suppress("DEPRECATION")
  private fun version(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >=
    28
  ) {
    info.longVersionCode
  } else {
    info.versionCode.toLong()
  }

  @Suppress("DEPRECATION")
  private fun signers(info: PackageInfo) = (
    if (Build.VERSION.SDK_INT >=
      28
    ) {
      info.signingInfo?.apkContentsSigners
    } else {
      info.signatures
    }
    )?.map { it.toCharsString() }?.toSet()

  override fun definition() = ModuleDefinition {
    Name("T3ForkUpdates")
    // Downloads and APK hashing must not occupy Expo's shared module queue.
    AsyncFunction("pending") { publicKey: String -> pending(publicKey) }
      .runOnQueue(appContext.backgroundCoroutineScope)
    AsyncFunction("download") { manifestUrl: String, signatureUrl: String, publicKey: String ->
      val bytes = get(manifestUrl, 65536)
      val signature = get(signatureUrl, 8192)
      val json = verifiedManifest(bytes, signature, publicKey)
      if (json.getLong("versionCode") <= version(packageInfo)) return@AsyncFunction null
      val apk = json.getJSONObject("apk")
      val saved = File(directory, "update.json")
      val savedApk = File(directory, "update.apk")
      val matchingManifest = saved.exists() && saved.readBytes().contentEquals(bytes)
      if (matchingManifest && savedApk.length() == apk.getLong("size") &&
        hash(savedApk) == apk.getString("sha256")
      ) {
        verifyPackage(savedApk, json.getLong("versionCode"))
        File(directory, "update.json.sig").writeBytes(signature)
        return@AsyncFunction json.getString("version")
      }
      val url = manifestUrl.substringBeforeLast('/') + "/" + apk.getString("name")
      val temporary = File(directory, "download.tmp")
      try {
        download(url, temporary, apk.getLong("size"))
        check(hash(temporary) == apk.getString("sha256")) { "Downloaded APK hash mismatch" }
        verifyPackage(temporary, json.getLong("versionCode"))
        check(temporary.renameTo(File(directory, "update.apk"))) { "Could not save update" }
        File(directory, "update.json.sig").writeBytes(signature)
        File(directory, "update.json").writeBytes(bytes)
      } finally {
        if (temporary.exists()) check(temporary.delete()) { "Could not remove partial update" }
      }
      json.getString("version")
    }.runOnQueue(appContext.backgroundCoroutineScope)
    AsyncFunction("install") { publicKey: String, requestPermission: Boolean ->
      val json =
        verifiedManifest(
          File(directory, "update.json").readBytes(),
          File(directory, "update.json.sig").readBytes(),
          publicKey
        )
      val apk = verifyApk(json)
      val activity = requireNotNull(appContext.currentActivity) { "Open the app before installing" }
      check(preferences.edit().putLong("attempted", json.getLong("versionCode")).commit()) {
        "Could not save install attempt"
      }
      if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
        if (!requestPermission) return@AsyncFunction "denied"
        activity.startActivity(
          Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + context.packageName)
          )
        )
        return@AsyncFunction "permission"
      }
      val uri = FileProvider.getUriForFile(context, context.packageName + ".forkupdates", apk)
      activity.startActivity(
        Intent(
          Intent.ACTION_VIEW
        ).setDataAndType(
          uri,
          "application/vnd.android.package-archive"
        ).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      )
      "requested"
    }.runOnQueue(appContext.backgroundCoroutineScope)
  }

  private fun pending(publicKey: String): Map<String, Any>? {
    val manifest = File(directory, "update.json")
    if (!manifest.exists()) return null
    val json =
      verifiedManifest(
        manifest.readBytes(),
        File(directory, "update.json.sig").readBytes(),
        publicKey
      )
    return if (json.getLong("versionCode") <= version(packageInfo)) {
      directory.listFiles()?.forEach { check(it.delete()) { "Could not remove old update" } }
      null
    } else {
      verifyApk(json)
      mapOf(
        "version" to json.getString("version"),
        "attempted" to (preferences.getLong("attempted", 0) == json.getLong("versionCode"))
      )
    }
  }

  private fun verifiedManifest(
    bytes: ByteArray,
    signature: ByteArray,
    publicKey: String
  ): JSONObject {
    val encoded = publicKey.replace(
      "-----BEGIN PUBLIC KEY-----",
      ""
    ).replace("-----END PUBLIC KEY-----", "").replace(Regex("\\s"), "")
    val key = KeyFactory.getInstance(
      "RSA"
    ).generatePublic(X509EncodedKeySpec(Base64.decode(encoded, Base64.DEFAULT)))
    val verifier = Signature.getInstance("SHA256withRSA")
    verifier.initVerify(key)
    verifier.update(bytes)
    check(verifier.verify(signature)) { "Update signature invalid" }
    val json = JSONObject(bytes.toString(Charsets.UTF_8))
    check(json.getInt("schema") == 1 && json.getLong("versionCode") > 0) {
      "Invalid update manifest"
    }
    val apk = json.getJSONObject("apk")
    check(apk.getString("name") == "T3-Code-Fork-Android-arm64.apk") {
      "Invalid update package name"
    }
    check(
      apk.getLong("size") in 1L..536870912L &&
        apk.getString("sha256").matches(Regex("[a-f0-9]{64}"))
    ) {
      "Invalid update package metadata"
    }
    return json
  }

  private fun verifyApk(json: JSONObject): File {
    val apk = File(directory, "update.apk")
    val metadata = json.getJSONObject("apk")
    check(apk.length() == metadata.getLong("size") && hash(apk) == metadata.getString("sha256")) {
      "Saved APK changed"
    }
    verifyPackage(apk, json.getLong("versionCode"))
    return apk
  }

  private fun verifyPackage(apk: File, versionCode: Long) {
    val candidate =
      context.packageManager.getPackageArchiveInfo(apk.path, signingFlags) ?: error("Invalid APK")
    val current = packageInfo
    check(
      candidate.packageName == context.packageName && version(candidate) == versionCode &&
        versionCode > version(current)
    ) { "APK package or version mismatch" }
    val incoming = signers(candidate)
    val existing = signers(current)
    check(!incoming.isNullOrEmpty() && incoming == existing) { "APK signing certificate mismatch" }
  }

  private fun hash(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(65536)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun connection(value: String): HttpURLConnection {
    val uri = Uri.parse(value)
    check(
      uri.scheme == "https" && uri.host == "github.com" &&
        uri.path?.startsWith("/Alb11747/t3code/releases/download/android-fork-") == true
    ) {
      "Invalid update URL"
    }
    return (URL(value).openConnection() as HttpURLConnection).apply {
      connectTimeout = 30000
      readTimeout = 60000
      instanceFollowRedirects = true
    }
  }

  private fun copyBounded(input: InputStream, output: OutputStream, limit: Long): Long {
    val buffer = ByteArray(65536)
    var total = 0L
    while (true) {
      val count = input.read(buffer)
      if (count < 0) return total
      total += count
      check(total <= limit) { "Download exceeds expected size" }
      output.write(buffer, 0, count)
    }
  }

  private fun get(value: String, limit: Int): ByteArray {
    val connection = connection(value)
    try {
      check(connection.responseCode == 200) { "Update HTTP " + connection.responseCode }
      val output = java.io.ByteArrayOutputStream()
      connection.inputStream.use { copyBounded(it, output, limit.toLong()) }
      return output.toByteArray()
    } finally {
      connection.disconnect()
    }
  }

  private fun download(value: String, file: File, size: Long) {
    val connection = connection(value)
    try {
      check(connection.responseCode == 200) { "APK HTTP " + connection.responseCode }
      val total = connection.inputStream.use { input ->
        file.outputStream().use { output -> copyBounded(input, output, size) }
      }
      check(total == size) { "APK download incomplete" }
    } finally {
      connection.disconnect()
    }
  }
}
