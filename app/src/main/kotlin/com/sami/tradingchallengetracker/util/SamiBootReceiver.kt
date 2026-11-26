package com.sami.tradingchallengetracker.util

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class SamiBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (context == null || intent == null) return
        val action = intent.action ?: return
        if (
            action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == "com.htc.intent.action.QUICKBOOT_POWERON"
        ) {
            val pendingResult = goAsync()
            try {
                SamiPushStandbyHelper.ensureFirebaseStandby(context.applicationContext) {
                    pendingResult.finish()
                }
            } catch (_: Throwable) {
                pendingResult.finish()
            }
        }
    }
}
