package com.sami.tradingchallengetracker.util

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.UUID
import kotlin.concurrent.thread

object SamiPushStandbyHelper {
    const val PREFS_NAME = "salim_native_prefs"
    const val CHANNEL_ID = "sami_channel_messages_v2"
    const val PRIVATE_CHANNEL_ID = "sami_private_messages_v2"
    const val UPDATES_CHANNEL_ID = "sami_app_updates_v2"
    const val ACTION_FCM_FOREGROUND_MESSAGE = "com.salim.tradingchallengetracker.FCM_FOREGROUND_MESSAGE"
    const val DEFAULT_SERVER_URL = "https://ais-pre-ljvmb2ezkv67qiojp5xgpk-877998647748.europe-west2.run.app"

    private const val FIREBASE_PROJECT_ID = "gen-lang-client-0204359963"
    private const val FIREBASE_STORAGE_BUCKET = "gen-lang-client-0204359963.firebasestorage.app"
    private const val FIREBASE_SENDER_ID = "577103059363"
    private const val FIREBASE_API_KEY = "AIzaSyCWSCiM0EVatqiBL5wUO8ZAfKcJHqud9dU"
    private const val FIREBASE_FALLBACK_APP_ID = "1:577103059363:web:9b26e4e49a67e9d1cea216"

    fun ensureNotificationChannel(context: Context) {
        ensureNotificationChannels(context)
    }

    fun ensureNotificationChannels(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
                val audioAttrs = AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
                    .build()

                val channelMsgs = NotificationChannel(
                    CHANNEL_ID,
                    "رسائل القنوات والتنبيهات",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "إشعارات القنوات والتوصيات الفورية في منصة Salim"
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 200, 100, 200)
                    enableLights(true)
                    setShowBadge(true)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                    setSound(soundUri, audioAttrs)
                }

                val privateMsgs = NotificationChannel(
                    PRIVATE_CHANNEL_ID,
                    "المحادثات الخاصة",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "إشعارات الرسائل الخاصة المباشرة مع القائد والمشرفين"
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 220, 110, 220)
                    enableLights(true)
                    setShowBadge(true)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                    setSound(soundUri, audioAttrs)
                }

                val appUpdates = NotificationChannel(
                    UPDATES_CHANNEL_ID,
                    "تحديثات التطبيق",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "تنبيهات توفر إصدارات وتحديثات تطبيق Salim"
                    enableVibration(true)
                    enableLights(true)
                    setShowBadge(true)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                    setSound(soundUri, audioAttrs)
                }

                manager.createNotificationChannel(channelMsgs)
                manager.createNotificationChannel(privateMsgs)
                manager.createNotificationChannel(appUpdates)
            } catch (_: Throwable) {}
        }
    }

    fun resolveChannelId(chatType: String?, messageType: String?): String {
        if (messageType == "app_update") return UPDATES_CHANNEL_ID
        if (chatType == "private") return PRIVATE_CHANNEL_ID
        return CHANNEL_ID
    }

    fun sanitizeServerUrl(rawUrl: String?): String {
        val trimmed = rawUrl?.trim().orEmpty()
        if (trimmed.isEmpty() || trimmed == "MY_APP_URL") return ""
        return try {
            val uri = Uri.parse(trimmed)
            val scheme = uri.scheme?.lowercase() ?: ""
            val host = uri.host?.lowercase() ?: ""
            if (
                scheme != "https" ||
                host.isEmpty() ||
                host == "localhost" ||
                host == "127.0.0.1" ||
                host == "0.0.0.0" ||
                host == "appassets.androidplatform.net" ||
                host.startsWith("ais-dev-") ||
                host.contains("wrwn7qrad4ng4e3ejalosp") ||
                host.contains("puwra2x2ecorh5lpokb4yk") ||
                host.endsWith(".usercontent.goog")
            ) {
                ""
            } else {
                trimmed.trimEnd('/')
            }
        } catch (_: Throwable) {
            ""
        }
    }

    fun getOrCreateDeviceId(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val existing = prefs.getString("device_id", null)
        if (!existing.isNullOrBlank()) return existing
        val generated = "and_${UUID.randomUUID().toString().replace("-", "").take(16)}"
        prefs.edit().putString("device_id", generated).apply()
        return generated
    }

    fun getServerBase(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString("remote_server_url", "")?.trim() ?: ""
        val clean = sanitizeServerUrl(saved)
        if (clean.isNotEmpty()) return clean
        if (saved.isNotEmpty()) {
            prefs.edit().putString("remote_server_url", DEFAULT_SERVER_URL).apply()
        }
        return DEFAULT_SERVER_URL
    }

    fun setAppForeground(context: Context, isForeground: Boolean) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean("is_app_foreground", isForeground)
            .putLong("foreground_updated_at", System.currentTimeMillis())
            .apply()
    }

    fun isAppForeground(context: Context): Boolean {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getBoolean("is_app_foreground", false)
    }

    fun isSameChatCurrentlyActive(
        context: Context,
        chatType: String,
        channelId: String,
        partnerId: String
    ): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val activeType = prefs.getString("active_chat_type", "") ?: ""
        if (chatType == "channel" && activeType == "channel") {
            val activeChannel = prefs.getString("active_channel_id", "") ?: ""
            return channelId.isNotBlank() && activeChannel == channelId
        }
        if (chatType == "private" && activeType == "private") {
            val activePartner = prefs.getString("active_partner_id", "") ?: ""
            return partnerId.isNotBlank() && activePartner == partnerId
        }
        return false
    }

    @Synchronized
    fun markMessageHandledIfNew(context: Context, messageId: String): Boolean {
        if (messageId.isBlank()) return true
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val raw = prefs.getString("recent_handled_msg_ids", "[]") ?: "[]"
        val arr = try {
            JSONArray(raw)
        } catch (_: Throwable) {
            JSONArray()
        }
        val list = ArrayList<String>()
        for (i in 0 until arr.length()) {
            val item = arr.optString(i, "")
            if (item.isNotBlank()) list.add(item)
        }
        if (list.contains(messageId)) {
            return false
        }
        list.add(messageId)
        while (list.size > 60) {
            list.removeAt(0)
        }
        val next = JSONArray()
        for (item in list) next.put(item)
        prefs.edit().putString("recent_handled_msg_ids", next.toString()).apply()
        return true
    }

    fun ensureFirebaseInitialized(context: Context): Boolean {
        return try {
            if (FirebaseApp.getApps(context).isNotEmpty()) {
                true
            } else {
                val defaultApp = FirebaseApp.initializeApp(context)
                if (defaultApp != null) {
                    true
                } else {
                    val resId = context.resources.getIdentifier("google_app_id", "string", context.packageName)
                    val appId = if (resId != 0) context.getString(resId) else FIREBASE_FALLBACK_APP_ID
                    if (resId == 0) {
                        Log.e(
                            "SamiPushStandby",
                            "Missing Android google-services.json (google_app_id resource absent). FCM registration requires an Android App ID (1:${FIREBASE_SENDER_ID}:android:...) registered for ${context.packageName}."
                        )
                    }
                    val opts = FirebaseOptions.Builder()
                        .setProjectId(FIREBASE_PROJECT_ID)
                        .setStorageBucket(FIREBASE_STORAGE_BUCKET)
                        .setGcmSenderId(FIREBASE_SENDER_ID)
                        .setApiKey(FIREBASE_API_KEY)
                        .setApplicationId(appId)
                        .build()
                    FirebaseApp.initializeApp(context, opts)
                    true
                }
            }
        } catch (t: Throwable) {
            Log.w("SamiPushStandby", "Firebase init note: ${t.message}")
            false
        }
    }

    fun ensureFirebaseStandby(context: Context, onTokenReady: ((String) -> Unit)? = null) {
        ensureNotificationChannels(context)
        if (!ensureFirebaseInitialized(context.applicationContext)) return
        try {
            FirebaseMessaging.getInstance().isAutoInitEnabled = true
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { token ->
                    if (!token.isNullOrBlank()) {
                        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                            .edit()
                            .putString("fcm_token", token)
                            .apply()
                        syncTokenToServerInBackground(context.applicationContext, token)
                        onTokenReady?.invoke(token)
                    }
                }
                .addOnFailureListener { err ->
                    Log.e("SamiPushStandby", "FCM token fetch failed: ${err.message}", err)
                }
        } catch (t: Throwable) {
            Log.e("SamiPushStandby", "FCM standby setup error: ${t.message}", t)
        }
    }

    fun syncTokenToServerInBackground(context: Context, rawToken: String?) {
        val token = rawToken?.trim().orEmpty()
        if (token.isEmpty()) return

        thread(isDaemon = true) {
            try {
                val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                val userIdStr = prefs.getString("active_user_id", "")?.trim() ?: ""
                val userId = userIdStr.toLongOrNull() ?: 0L
                if (userId <= 0L) return@thread

                val username = prefs.getString("active_username", "")?.trim() ?: ""
                val authToken = prefs.getString("active_auth_token", "")?.trim() ?: ""
                val deviceId = getOrCreateDeviceId(context)
                val serverBase = getServerBase(context)
                val endpoint = "$serverBase/api/fcm/register"

                val sessionJson = JSONObject().apply {
                    put("id", userId)
                    put("username", username)
                    put("displayName", username)
                    put("role", if (userId == 1L) "owner" else "user")
                    put("isGuest", false)
                }.toString()

                val bodyJson = JSONObject().apply {
                    put("token", token)
                    put("deviceId", deviceId)
                    put("platform", "android")
                    put("deviceModel", "${Build.MANUFACTURER} ${Build.MODEL}".trim().take(100))
                }.toString()

                val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 12000
                    readTimeout = 12000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    setRequestProperty("x-sami-session", URLEncoder.encode(sessionJson, "UTF-8"))
                    if (authToken.isNotBlank()) {
                        setRequestProperty("Authorization", "Bearer $authToken")
                    }
                }

                OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { writer ->
                    writer.write(bodyJson)
                    writer.flush()
                }
                conn.responseCode
                conn.disconnect()
            } catch (_: Throwable) {}
        }
    }

    fun unregisterTokenFromServerInBackground(
        context: Context,
        rawToken: String?,
        userIdOverride: String? = null,
        authTokenOverride: String? = null
    ) {
        thread(isDaemon = true) {
            try {
                val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                val userIdStr = (userIdOverride ?: prefs.getString("active_user_id", "") ?: "").trim()
                val userId = userIdStr.toLongOrNull() ?: 0L
                if (userId <= 0L) return@thread

                val authToken = (authTokenOverride ?: prefs.getString("active_auth_token", "") ?: "").trim()
                val deviceId = getOrCreateDeviceId(context)
                val serverBase = getServerBase(context)
                val endpoint = "$serverBase/api/fcm/unregister"

                val sessionJson = JSONObject().apply {
                    put("id", userId)
                    put("isGuest", false)
                }.toString()

                val bodyJson = JSONObject().apply {
                    if (!rawToken.isNullOrBlank()) put("token", rawToken.trim())
                    put("deviceId", deviceId)
                }.toString()

                val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 10000
                    readTimeout = 10000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    setRequestProperty("x-sami-session", URLEncoder.encode(sessionJson, "UTF-8"))
                    if (authToken.isNotBlank()) {
                        setRequestProperty("Authorization", "Bearer $authToken")
                    }
                }
                OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { writer ->
                    writer.write(bodyJson)
                    writer.flush()
                }
                conn.responseCode
                conn.disconnect()
            } catch (_: Throwable) {}
        }
    }
}
