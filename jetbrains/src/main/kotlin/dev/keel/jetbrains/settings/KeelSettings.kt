package dev.keel.jetbrains.settings

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project

/** How the plugin reaches keel. No secret is kept here: the device token lives in the IDE's PasswordSafe. */
@Service(Service.Level.APP)
@State(name = "KeelSettings", storages = [Storage("keel.xml")])
class KeelSettings : SimplePersistentStateComponent<KeelSettings.S>(S()) {
    class S : BaseState() {
        var url by string(DEFAULT_URL)

        /** local: `keel2 auth key` on this computer; paired: a device token from Settings › Devices › Pair. */
        var mode by string(MODE_LOCAL)
        var deviceName by string()
        var notify by property(true)

        /** Review mode: a changed file counts as viewed once it is opened. */
        var markViewed by property(true)
    }

    val url: String get() = state.url?.ifBlank { null } ?: DEFAULT_URL
    val mode: String get() = state.mode ?: MODE_LOCAL

    companion object {
        const val DEFAULT_URL = "http://localhost:8088"
        const val MODE_LOCAL = "local"
        const val MODE_PAIRED = "paired"
        fun get(): KeelSettings = service()
    }
}

/** The keel project this IDE project is, when it was picked by hand (else it is found by folder). */
@Service(Service.Level.PROJECT)
@State(name = "KeelProject", storages = [Storage(StoragePathMacros.WORKSPACE_FILE)])
class KeelProjectSettings : SimplePersistentStateComponent<KeelProjectSettings.S>(S()) {
    class S : BaseState() {
        var projectId by string()
    }

    companion object {
        fun of(project: Project): KeelProjectSettings = project.service()
    }
}

/** Device tokens in the IDE's PasswordSafe (the OS keychain or KeePass), one per keel address. Call off the EDT. */
object KeelCredentials {
    private fun attrs(url: String) = CredentialAttributes(generateServiceName("keel", "device token $url"))

    fun deviceToken(url: String): String? = PasswordSafe.instance.getPassword(attrs(url))?.ifBlank { null }

    fun setDeviceToken(url: String, token: String?) = PasswordSafe.instance.setPassword(attrs(url), token)
}
