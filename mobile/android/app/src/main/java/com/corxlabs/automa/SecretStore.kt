package com.corxlabs.automa

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypts small secrets (a server's app key) with a key that lives in the
 * Android Keystore, so the value in this app's preferences is useless on its
 * own: a copied preferences file, a backup, or a debugger reading storage
 * still needs this device's hardware-backed key to turn it back into text.
 * The key never leaves the Keystore; AES-GCM with a fresh nonce per value.
 */
object SecretStore {
    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "automa.secrets"
    private const val PREFIX = "enc1:"
    private const val NONCE_BYTES = 12
    private const val TAG_BITS = 128

    /** `enc1:<base64 nonce+ciphertext>`, or the plain text if the Keystore is unavailable. */
    fun seal(plain: String): String {
        val key = key() ?: return plain
        return runCatching {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val sealed = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
            PREFIX + Base64.encodeToString(cipher.iv + sealed, Base64.NO_WRAP)
        }.getOrDefault(plain)
    }

    /** The text behind [stored]; a value saved before encryption existed comes back as is. */
    fun open(stored: String): String? {
        if (!stored.startsWith(PREFIX)) return stored
        val key = key() ?: return null
        return runCatching {
            val bytes = Base64.decode(stored.removePrefix(PREFIX), Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, bytes, 0, NONCE_BYTES))
            String(cipher.doFinal(bytes, NONCE_BYTES, bytes.size - NONCE_BYTES), Charsets.UTF_8)
        }.getOrNull()
    }

    private fun key(): SecretKey? = runCatching {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return@runCatching it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        generator.generateKey()
    }.getOrNull()
}
