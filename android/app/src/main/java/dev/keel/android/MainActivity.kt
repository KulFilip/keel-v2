package dev.keel.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableStateOf
import dev.keel.android.ui.AppRoot
import dev.keel.android.ui.theme.KeelTheme

class MainActivity : ComponentActivity() {
    /** A keel://pair link this activity was opened with (the QR code scanned by the camera app). */
    private val link = mutableStateOf<String?>(null)
    private val open = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        read(intent)
        val app = application as KeelApp
        setContent {
            KeelTheme {
                AppRoot(
                    app = app,
                    link = link.value,
                    onLinkUsed = { link.value = null },
                    open = open.value,
                    onOpenUsed = { open.value = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        read(intent)
    }

    private fun read(intent: Intent?) {
        val data = intent?.data
        if (data != null && data.scheme == "keel") link.value = data.toString()
        // debug builds: `adb shell am start ... --ez demo true --es open flows` shows a screen with the demo's data
        if (BuildConfig.DEMO && intent?.getBooleanExtra(EXTRA_DEMO, false) == true) (application as KeelApp).session.startDemo()
        intent?.getStringExtra(EXTRA_OPEN)?.let { open.value = it }
    }

    companion object {
        const val EXTRA_OPEN = "open"
        const val EXTRA_DEMO = "demo"
    }
}
