package com.jarvis.resident

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * On-device storage for user-supplied AI credentials.
 *
 * Keys never belong in the APK, WebView localStorage or a hosted configuration.
 * Only Android code should access this vault; never expose a JavaScript method
 * that returns plaintext credentials to a remote WebView.
 */
internal class ProviderCredentialVault(private val context: Context) {
    private val alias = "jarvis.provider.credentials.v1"
    private val prefs = context.getSharedPreferences("jarvis_secure_providers", Context.MODE_PRIVATE)

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    @Synchronized
    fun save(providerId: String, apiKey: String) {
        require(providerId.matches(Regex("[a-zA-Z0-9_-]{1,64}"))) { "Invalid provider identifier" }
        require(apiKey.isNotBlank() && apiKey.length <= 8192) { "Invalid credential" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        cipher.updateAAD(providerId.toByteArray(StandardCharsets.UTF_8))
        val encrypted = cipher.doFinal(apiKey.toByteArray(StandardCharsets.UTF_8))
        val packed = cipher.iv + encrypted
        check(prefs.edit().putString(providerId, Base64.encodeToString(packed, Base64.NO_WRAP)).commit()) {
            "Unable to save credential"
        }
    }

    @Synchronized
    fun has(providerId: String): Boolean = prefs.contains(providerId)

    @Synchronized
    fun remove(providerId: String): Boolean = prefs.edit().remove(providerId).commit()

    @Synchronized
    fun listProviderIds(): List<String> = prefs.all.keys.sorted()

    @Synchronized
    fun clear(): Boolean = prefs.edit().clear().commit()

    /** Android-internal only: never return this value through a WebView JS bridge. */
    @Synchronized
    fun readForNativeRequest(providerId: String): String? {
        val value = prefs.getString(providerId, null) ?: return null
        val packed = Base64.decode(value, Base64.NO_WRAP)
        require(packed.size > 12 + 16) { "Invalid encrypted credential" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, packed.copyOfRange(0, 12)))
        cipher.updateAAD(providerId.toByteArray(StandardCharsets.UTF_8))
        return String(cipher.doFinal(packed.copyOfRange(12, packed.size)), StandardCharsets.UTF_8)
    }
}
