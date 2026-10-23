package dev.keel.android.ui.settings

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.keel.android.BuildConfig
import dev.keel.android.data.KeelSession
import dev.keel.android.notify.Notifier
import dev.keel.android.ui.common.DetailBar
import dev.keel.android.ui.common.HomeViewModel
import dev.keel.android.ui.common.KeelMark
import dev.keel.android.ui.common.PillButton
import dev.keel.android.ui.common.SectionLabel
import dev.keel.android.ui.theme.K
import dev.keel.android.ui.theme.Mono

/** The keels this phone is paired with (switch, forget, pair another one) and the notifications. */
@Composable
fun SettingsScreen(session: KeelSession, home: HomeViewModel, notifier: Notifier, onBack: () -> Unit, onPair: () -> Unit) {
    val keels by session.store.keels.collectAsState()
    val activeId by session.store.activeId.collectAsState()
    val context = LocalContext.current
    Column(Modifier.fillMaxSize()) {
        DetailBar("Settings", "keel for Android ${BuildConfig.VERSION_NAME}", onBack, "Back")
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionLabel("Your keels")
            keels.forEach { k ->
                val on = k.id == activeId
                val shape = RoundedCornerShape(14.dp)
                Column(
                    Modifier.fillMaxWidth().clip(shape).background(if (on) K.c.accentSoft else K.c.panel).border(1.dp, if (on) K.c.accent else K.c.border, shape)
                        .clickable(role = Role.Button, onClickLabel = "Use ${k.name}") { session.select(k.id); home.load() }.padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        KeelMark()
                        Column(Modifier.weight(1f)) {
                            Text(k.name + if (on) "  · in use" else "", fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = K.c.fg)
                            Text(k.url, fontFamily = Mono, fontSize = 12.sp, color = K.c.dim)
                            if (k.version.isNotBlank()) Text("keel ${k.version}", fontSize = 12.sp, color = K.c.dim)
                        }
                    }
                    PillButton("Forget on this phone", { session.forget(k.id); if (session.store.keels.value.isEmpty()) onPair() })
                }
            }
            PillButton("Pair another keel", onPair, Modifier.fillMaxWidth(), filled = true)
            Text("Forget only removes the keel from this phone. To take the phone's access away, remove it in keel's Settings › Devices.", fontSize = 13.sp, color = K.c.dim, lineHeight = 19.sp)

            SectionLabel("Notifications")
            Text(
                if (notifier.allowed()) "On: the phone tells you when a question waits (checked while the app is open, and every 15 minutes in the background)."
                else "Off: allow notifications so the phone tells you when a question waits.",
                fontSize = 14.sp, color = K.c.text2, lineHeight = 20.sp,
            )
            PillButton("Notification settings", {
                context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }, Modifier.heightIn(min = 48.dp))
            SectionLabel("Look")
            Text("Dark or light follows the phone's setting.", fontSize = 14.sp, color = K.c.text2)
        }
    }
}
