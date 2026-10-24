package com.devino.caramel.core

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Saved-store lists in SharedPreferences, as JSON arrays. */
class PrefsListStore(context: Context) : ListStore {
    private val prefs: SharedPreferences = context.getSharedPreferences("caramel_lists", Context.MODE_PRIVATE)
    private val serializer = ListSerializer(String.serializer())

    override fun read(key: String): List<String> {
        val raw = prefs.getString(key, null) ?: return emptyList()
        return Json.decodeFromString(serializer, raw)
    }

    override fun write(key: String, values: List<String>) {
        // commit(), not apply(): a failed write must not be silent.
        check(prefs.edit().putString(key, Json.encodeToString(serializer, values)).commit()) {
            "Could not save the list '$key' on this device."
        }
    }
}

/**
 * The session bearer, AES-GCM encrypted under a key that never leaves the Android Keystore (the
 * iOS app keeps it in the keychain). The ciphertext lives in app-private SharedPreferences, which
 * backup and device transfer exclude (data_extraction_rules.xml).
 */
class KeystoreTokenStore(context: Context) : TokenStore {
    private val prefs: SharedPreferences = context.getSharedPreferences("caramel_session", Context.MODE_PRIVATE)

    override fun read(): String? {
        val stored = prefs.getString(TOKEN_KEY, null) ?: return null
        try {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val iv = bytes.copyOfRange(0, IV_BYTES)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
            return cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES).toString(Charsets.UTF_8)
        } catch (e: GeneralSecurityException) {
            // The key was lost (a restored device, a changed lock screen): the stored token is
            // unusable. Drop it so the next sign-in starts clean, and say so.
            delete()
            throw TokenStoreException("Your saved sign-in could not be read on this device. Please sign in again.", e)
        } catch (e: IllegalArgumentException) {
            delete()
            throw TokenStoreException("Your saved sign-in was damaged. Please sign in again.", e)
        }
    }

    override fun write(token: String) {
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val encrypted = cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8))
            check(prefs.edit().putString(TOKEN_KEY, Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit()) {
                "Could not save the sign-in on this device."
            }
        } catch (e: GeneralSecurityException) {
            throw TokenStoreException("This device could not store your sign-in securely: ${e.message}", e)
        }
    }

    override fun delete() {
        check(prefs.edit().remove(TOKEN_KEY).commit()) { "Could not clear the saved sign-in on this device." }
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "caramel_session_key"
        const val TOKEN_KEY = "session_token_encrypted"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}
