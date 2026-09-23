package com.nova.downloadmanager.downloads

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Persists only the minimum transfer intent required for durable resume.
 *
 * Direct URLs may contain signed query parameters or other credentials, so
 * they are encrypted with an Android Keystore AES/GCM key before entering
 * SharedPreferences. Task metadata remains separately redacted.
 */
internal class SecureTransferIntentStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    fun put(taskId: String, url: String) {
        require(taskId.isNotBlank()) { "taskId must not be blank" }
        require(url.isNotBlank()) { "url must not be blank" }

        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val ciphertext = cipher.doFinal(url.toByteArray(Charsets.UTF_8))
        val encoded = listOf(
            Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
            Base64.encodeToString(ciphertext, Base64.NO_WRAP),
        ).joinToString(SEPARATOR)
        check(preferences.edit().putString(taskId, encoded).commit()) {
            "Failed to persist encrypted NOVA transfer intent"
        }
    }

    fun get(taskId: String): String? {
        val encoded = preferences.getString(taskId, null) ?: return null
        val parts = encoded.split(SEPARATOR, limit = 2)
        if (parts.size != 2) {
            remove(taskId)
            return null
        }

        return runCatching {
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val ciphertext = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(GCM_TAG_BITS, iv),
            )
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        }.getOrElse {
            remove(taskId)
            null
        }
    }

    fun remove(taskId: String) {
        preferences.edit().remove(taskId).commit()
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        return KeyGenerator
            .getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
            .apply {
                init(
                    KeyGenParameterSpec.Builder(
                        KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                    )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setRandomizedEncryptionRequired(true)
                        .build(),
                )
            }
            .generateKey()
    }

    private companion object {
        const val PREFERENCES_NAME = "nova_transfer_intents_secure"
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val KEY_ALIAS = "nova_transfer_intent_key_v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        const val SEPARATOR = "."
    }
}
