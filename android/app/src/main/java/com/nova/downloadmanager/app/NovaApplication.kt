package com.nova.downloadmanager.app

import android.app.Application
import androidx.work.Configuration

/**
 * Owns application-wide Android configuration only. Transfer semantics remain
 * in the Rust core once its typed task session is packaged.
 */
class NovaApplication : Application(), Configuration.Provider {
    override val workManagerConfiguration: Configuration = Configuration.Builder()
        // Keep WorkManager-generated job IDs separate from future NOVA UIDT
        // job IDs so the two Android dispatch paths cannot collide.
        .setJobSchedulerJobIdRange(10_000, 10_999)
        .build()
}
