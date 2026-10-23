package dev.keel.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** A keel this phone is paired with. The device token is kept apart, encrypted (see [PrefsKeelStore]). */
@Serializable
data class SavedKeel(
    val id: String,
    val name: String,
    val url: String,
    val deviceId: String = "",
    val version: String = "",
    /** the project the Flows, PRs and KeelBot tabs show */
    val project: String? = null,
    val demo: Boolean = false,
)

interface KeelStore {
    val keels: StateFlow<List<SavedKeel>>
    val activeId: StateFlow<String?>
    fun save(keel: SavedKeel, token: String)
    fun token(id: String): String?
    fun setActive(id: String?)
    fun remove(id: String)
    fun setProject(id: String, project: String?)

    /** Question ids a notification was already shown for (the background check tells each one once). */
    fun seenQuestions(): Set<String>
    fun setSeenQuestions(ids: Set<String>)
}

/** For tests and the demo: nothing leaves memory. */
class MemoryKeelStore : KeelStore {
    private val list = MutableStateFlow<List<SavedKeel>>(emptyList())
    private val active = MutableStateFlow<String?>(null)
    private val tokens = mutableMapOf<String, String>()
    private var seen = emptySet<String>()
    override val keels: StateFlow<List<SavedKeel>> = list.asStateFlow()
    override val activeId: StateFlow<String?> = active.asStateFlow()
    override fun save(keel: SavedKeel, token: String) {
        tokens[keel.id] = token
        list.value = list.value.filterNot { it.id == keel.id } + keel
    }
    override fun token(id: String) = tokens[id]
    override fun setActive(id: String?) { active.value = id }
    override fun remove(id: String) {
        tokens.remove(id)
        list.value = list.value.filterNot { it.id == id }
        if (active.value == id) active.value = list.value.firstOrNull()?.id
    }
    override fun setProject(id: String, project: String?) {
        list.value = list.value.map { if (it.id == id) it.copy(project = project) else it }
    }
    override fun seenQuestions() = seen
    override fun setSeenQuestions(ids: Set<String>) { seen = ids }
}

/**
 * The saved keels in SharedPreferences; each device token encrypted with an AES-GCM key that lives in the Android
 * Keystore (it never leaves the secure hardware, and the token is never written in clear).
 */
class PrefsKeelStore(context: Context) : KeelStore {
    private val prefs = context.getSharedPreferences("keels", Context.MODE_PRIVATE)
    private val listSer = ListSerializer(SavedKeel.serializer())
    private val list = MutableStateFlow(load())
    private val active = MutableStateFlow(prefs.getString(ACTIVE, null)?.takeIf { id -> list.value.any { it.id == id } } ?: list.value.firstOrNull()?.id)
    override val keels: StateFlow<List<SavedKeel>> = list.asStateFlow()
    override val activeId: StateFlow<String?> = active.asStateFlow()

    private fun load(): List<SavedKeel> = runCatching {
        KeelJson.decodeFromString(listSer, prefs.getString(LIST, "[]") ?: "[]")
    }.getOrDefault(emptyList())

    private fun persist(next: List<SavedKeel>) {
        list.value = next
        prefs.edit().putString(LIST, KeelJson.encodeToString(listSer, next)).apply()
    }

    override fun save(keel: SavedKeel, token: String) {
        prefs.edit().putString(TOKEN + keel.id, TokenCipher.encrypt(token)).apply()
        persist(list.value.filterNot { it.id == keel.id } + keel)
    }

    override fun token(id: String): String? = prefs.getString(TOKEN + id, null)?.let { runCatching { TokenCipher.decrypt(it) }.getOrNull() }

    override fun setActive(id: String?) {
        active.value = id
        prefs.edit().putString(ACTIVE, id).apply()
    }

    override fun remove(id: String) {
        prefs.edit().remove(TOKEN + id).apply()
        persist(list.value.filterNot { it.id == id })
        if (active.value == id) setActive(list.value.firstOrNull()?.id)
    }

    override fun setProject(id: String, project: String?) = persist(list.value.map { if (it.id == id) it.copy(project = project) else it })

    override fun seenQuestions(): Set<String> = prefs.getStringSet(SEEN, emptySet()) ?: emptySet()
    override fun setSeenQuestions(ids: Set<String>) { prefs.edit().putStringSet(SEEN, ids.toSet()).apply() }

    private companion object {
        const val LIST = "list"
        const val ACTIVE = "active"
        const val TOKEN = "token."
        const val SEEN = "seen-questions"
    }
}

/** AES-256-GCM with a key in the Android Keystore; the stored text is base64(iv + ciphertext). */
object TokenCipher {
    private const val ALIAS = "keel-device-tokens"
    private const val TRANSFORM = "AES/GCM/NoPadding"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    fun encrypt(plain: String): String {
        val c = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val out = c.iv + c.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    fun decrypt(stored: String): String {
        val all = Base64.decode(stored, Base64.NO_WRAP)
        val iv = all.copyOfRange(0, 12)
        val c = Cipher.getInstance(TRANSFORM).apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)) }
        return String(c.doFinal(all.copyOfRange(12, all.size)), Charsets.UTF_8)
    }
}
