package dev.keel.android

import android.app.Application
import android.os.Build
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import dev.keel.android.data.DemoBackend
import dev.keel.android.data.KeelSession
import dev.keel.android.data.LiveHub
import dev.keel.android.data.PrefsKeelStore
import dev.keel.android.notify.InboxCheckWorker
import dev.keel.android.notify.Notifier
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/** The app's objects (a small hand-made container: no DI framework for a handful of singletons). */
class KeelApp : Application() {
    lateinit var session: KeelSession
        private set
    lateinit var live: LiveHub
        private set
    lateinit var notifier: Notifier
        private set
    private val scope = MainScope()
    private var started = false

    override fun onCreate() {
        super.onCreate()
        val demo by lazy { DemoBackend() }
        session = KeelSession(PrefsKeelStore(this), deviceName = Build.MODEL ?: "Android", demoClient = { demo.client() })
        live = LiveHub(scope)
        notifier = Notifier(this)
        notifier.createChannel()
        InboxCheckWorker.schedule(this)

        // the live stream runs while the app is in the foreground, for the active keel and project
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                started = true
                follow()
            }

            override fun onStop(owner: LifecycleOwner) {
                started = false
                live.stop()
            }
        })
        scope.launch { session.active.collectLatest { if (started) follow() } }
    }

    private fun follow() {
        val a = session.active.value
        live.follow(a?.api, a?.keel?.project, a?.keel?.demo == true)
    }
}
