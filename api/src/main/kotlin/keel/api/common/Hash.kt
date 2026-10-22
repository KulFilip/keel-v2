package keel.api.common

import java.security.MessageDigest

/** SHA-256 and constant-time compare, in one place. Hex is lower case, text is UTF-8. */
object Hash {
    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    fun sha256Hex(bytes: ByteArray): String = hex(sha256(bytes))

    fun sha256Hex(text: String): String = sha256Hex(text.toByteArray())

    /** Same bytes? Takes the same time wherever they differ (secrets and tokens). */
    fun constantTimeEquals(a: String, b: String): Boolean = MessageDigest.isEqual(a.toByteArray(), b.toByteArray())
}
