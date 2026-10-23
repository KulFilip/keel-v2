package dev.keel.android.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.keel.android.MainActivity
import dev.keel.android.R
import dev.keel.android.data.InboxItem
import dev.keel.android.data.KeelApi
import dev.keel.android.data.KeelStore

/** Local notifications only (no push server yet): "A question waits for you". */
class Notifier(private val context: Context) {
    fun createChannel() {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Questions from keel", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A flow waits for your answer"
            },
        )
    }

    fun allowed(): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun questionsWaiting(newOnes: List<InboxItem>, total: Int) {
        if (newOnes.isEmpty() || !allowed()) return
        val first = newOnes.first()
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(MainActivity.EXTRA_OPEN, "inbox")
        }
        val pi = PendingIntent.getActivity(context, 1, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val title = if (newOnes.size == 1) "A question waits for you" else "${newOnes.size} questions wait for you"
        val text = first.title.ifBlank { first.flow } + if (first.projectName.isNotBlank()) " · ${first.projectName}" else ""
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setNumber(total)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(ID, n)
        } catch (_: SecurityException) {
            // the person took the permission back
        }
    }

    companion object {
        const val CHANNEL = "questions"
        const val ID = 1001

        /**
         * Ask keel's inbox and tell the questions not told before (the store keeps the seen ids). Returns the inbox
         * size. Used by the background check and while the app is open.
         */
        suspend fun check(api: KeelApi, store: KeelStore, notifier: Notifier?): Int {
            val items = api.inbox().items.filter { it.kind != "task" }
            val keyOf = { it: InboxItem -> it.id ?: "${it.threadId}:${it.step}:${it.title}" }
            val seen = store.seenQuestions()
            val fresh = items.filter { keyOf(it) !in seen }
            store.setSeenQuestions(items.map(keyOf).toSet())
            notifier?.questionsWaiting(fresh, items.size)
            return items.size
        }
    }
}
