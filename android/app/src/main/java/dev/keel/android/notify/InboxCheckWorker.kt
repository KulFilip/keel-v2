package dev.keel.android.notify

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.keel.android.KeelApp
import dev.keel.android.data.KeelException
import java.util.concurrent.TimeUnit

/** Every 15 minutes (Android's shortest period), even with the app closed: does a question wait? */
class InboxCheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as KeelApp
        val active = app.session.active.value ?: return Result.success()
        if (active.keel.demo) return Result.success()
        return try {
            Notifier.check(active.api, app.session.store, app.notifier)
            Result.success()
        } catch (e: KeelException) {
            // keel is off or the phone is away from its Wi-Fi: try at the next period, not in a loop
            Result.success()
        }
    }

    companion object {
        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<InboxCheckWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("inbox-check", ExistingPeriodicWorkPolicy.KEEP, req)
        }
    }
}
