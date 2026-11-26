package com.sami.tradingchallengetracker.util

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.sami.tradingchallengetracker.MainActivity
import org.json.JSONObject

class SamiFirebaseMessagingService : FirebaseMessagingService() {
    override fun onCreate() {
        super.onCreate()
        SamiPushStandbyHelper.ensureNotificationChannels(this)
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        getSharedPreferences(SamiPushStandbyHelper.PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString("fcm_token", token)
            .apply()
        SamiPushStandbyHelper.syncTokenToServerInBackground(applicationContext, token)
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        try {
            val title = remoteMessage.notification?.title
                ?: remoteMessage.data["title"]
                ?: "Salim"
            val body = remoteMessage.notification?.body
                ?: remoteMessage.data["body"]
                ?: "لديك إشعار جديد"

            val rawChatType = remoteMessage.data["chatType"] ?: ""
            val channelId = remoteMessage.data["channelId"] ?: ""
            val partnerId = remoteMessage.data["partnerId"] ?: ""
            val senderId = remoteMessage.data["senderId"] ?: ""
            val messageId = remoteMessage.data["messageId"] ?: ""
            val senderName = remoteMessage.data["senderName"] ?: ""
            val messageType = remoteMessage.data["type"] ?: ""

            val resolvedChatType = if (
                rawChatType == "private" ||
                (channelId.isBlank() && (partnerId.isNotBlank() || senderId.isNotBlank()) && messageType != "app_update")
            ) {
                "private"
            } else {
                "channel"
            }
            val effectivePartnerId = partnerId.ifBlank { senderId }

            if (!SamiPushStandbyHelper.markMessageHandledIfNew(this, messageId)) {
                return
            }

            // Always notify active UI via local app broadcast so live chat state refreshes immediately
            val fgPayload = JSONObject().apply {
                put("chatType", resolvedChatType)
                put("channelId", channelId)
                put("partnerId", effectivePartnerId)
                put("senderId", senderId)
                put("senderName", senderName)
                put("messageId", messageId)
                put("type", messageType)
                put("title", title)
                put("body", body)
            }
            val fgIntent = Intent(SamiPushStandbyHelper.ACTION_FCM_FOREGROUND_MESSAGE).apply {
                setPackage(packageName)
                putExtra("payloadJson", fgPayload.toString())
            }
            sendBroadcast(fgIntent)

            // Suppress noisy OS banner if user is currently viewing that exact conversation in foreground
            val isViewingSameChat =
                SamiPushStandbyHelper.isAppForeground(this) &&
                SamiPushStandbyHelper.isSameChatCurrentlyActive(
                    this,
                    resolvedChatType,
                    channelId,
                    effectivePartnerId
                )
            if (isViewingSameChat) {
                return
            }

            SamiPushStandbyHelper.ensureNotificationChannels(this)
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val notifChannelId = SamiPushStandbyHelper.resolveChannelId(resolvedChatType, messageType)

            val intent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("chatType", resolvedChatType)
                putExtra("channelId", if (resolvedChatType == "channel") channelId else "")
                putExtra("partnerId", if (resolvedChatType == "private") effectivePartnerId else "")
                putExtra("senderId", senderId)
                putExtra("messageId", messageId)
                putExtra("senderName", senderName)
            }
            val reqCode = (messageId.ifBlank { System.currentTimeMillis().toString() }).hashCode()
            val pendingIntent = PendingIntent.getActivity(
                this,
                reqCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val groupKey = if (resolvedChatType == "private") {
                "salim_group_pm_$effectivePartnerId"
            } else {
                "salim_group_ch_$channelId"
            }

            val notification = NotificationCompat.Builder(this, notifChannelId)
                .setSmallIcon(applicationInfo.icon)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setGroup(groupKey)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setContentIntent(pendingIntent)
                .build()

            manager.notify(reqCode, notification)
        } catch (_: Throwable) {}
    }
}
