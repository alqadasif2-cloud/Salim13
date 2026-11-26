package com.sami.tradingchallengetracker.util

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class SamiUpdateReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (context != null && intent?.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
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
