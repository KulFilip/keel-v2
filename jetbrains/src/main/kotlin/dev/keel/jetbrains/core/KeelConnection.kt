package dev.keel.jetbrains.core

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ApplicationNamesInfo
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.ProjectManager
import dev.keel.jetbrains.api.KeelApi
import dev.keel.jetbrains.api.KeelException
import dev.keel.jetbrains.api.LocalKey
import dev.keel.jetbrains.api.deviceName
import dev.keel.jetbrains.settings.KeelCredentials
import dev.keel.jetbrains.settings.KeelSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.InetAddress

/**
 * The one keel connection of the IDE: builds a [KeelApi] from the settings and finds its sign-in (keel2's web key, or
 * the paired device token). The secret stays in memory and in PasswordSafe; it is never written to a log.
 */
@Service(Service.Level.APP)
class KeelConnection {
    @Volatile private var secret: String? = null
    @Volatile private var api: KeelApi? = null
    @Volatile private var builtFor: String? = null

    /** The client, signed in. Blocking work (keel2, PasswordSafe) runs on the IO pool. */
    suspend fun ensure(): KeelApi = withContext(Dispatchers.IO) {
        val s = KeelSettings.get()
        val key = "${s.url}|${s.mode}"
        api?.takeIf { builtFor == key && secret != null }?.let { return@withContext it }
        val token = when (s.mode) {
            KeelSettings.MODE_PAIRED -> KeelCredentials.deviceToken(s.url)
                ?: throw KeelException(401, "This IDE is not paired with keel.", "Settings › Tools › keel: pair with a code, or use keel2 on this computer.")
            else -> try {
                LocalKey.read()
            } catch (e: LocalKey.Failed) {
                throw KeelException(401, e.message ?: "keel2 auth key failed.", e.hint ?: "Is keel running? keel2 status")
            }
        }
        secret = token
        builtFor = key
        KeelApi(s.url, token = { secret }, onRemoved = ::removed).also { api = it }
    }

    /** A client without sign-in (pairing, health). */
    fun anonymous(url: String = KeelSettings.get().url): KeelApi = KeelApi(url, token = { null })

    /** Forget the client and the secret in memory (after a settings change); the projects connect again. */
    fun reset() {
        secret = null
        api = null
        builtFor = null
        ApplicationManager.getApplication().invokeLater {
            ProjectManager.getInstance().openProjects.filter { !it.isDisposed }.forEach { KeelProjectService.of(it).reconnect() }
        }
    }

    private fun removed() {
        // keel no longer takes this sign-in: a removed device, or a new sign-in key (keel2 auth reset)
        secret = null
        api = null
        if (KeelSettings.get().mode == KeelSettings.MODE_PAIRED) {
            ApplicationManager.getApplication().executeOnPooledThread { KeelCredentials.setDeviceToken(KeelSettings.get().url, null) }
        }
    }

    companion object {
        fun get(): KeelConnection = service()

        fun defaultDeviceName(): String {
            val host = runCatching { InetAddress.getLocalHost().hostName }.getOrNull() ?: System.getenv("HOSTNAME").orEmpty()
            return deviceName(ApplicationNamesInfo.getInstance().fullProductName, host)
        }
    }
}
