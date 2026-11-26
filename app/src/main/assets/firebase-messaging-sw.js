// Firebase Messaging & Web Push Service Worker for always-ready background notifications
/* eslint-disable no-restricted-globals */

const STANDBY_CACHE_NAME = 'salim-push-standby-v1';
const STANDBY_CONFIG_KEY = '/__salim_push_standby__.json';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function saveStandbyConfig(config) {
  try {
    const cache = await caches.open(STANDBY_CACHE_NAME);
    if (!config || !config.userId) {
      await cache.delete(STANDBY_CONFIG_KEY);
      return;
    }
    await cache.put(
      STANDBY_CONFIG_KEY,
      new Response(JSON.stringify(config), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
  } catch {}
}

async function loadStandbyConfig() {
  try {
    const cache = await caches.open(STANDBY_CACHE_NAME);
    const res = await cache.match(STANDBY_CONFIG_KEY);
    if (!res) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = self.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'SALIM_SYNC_PUSH_STANDBY' && msg.payload) {
    event.waitUntil(saveStandbyConfig(msg.payload));
  } else if (msg.type === 'SALIM_CLEAR_PUSH_STANDBY') {
    event.waitUntil(saveStandbyConfig(null));
  } else if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Automatically renew rotated push subscriptions while the app is completely closed
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cfg = await loadStandbyConfig();
        if (!cfg || !cfg.userId) return;
        const base = typeof cfg.apiBase === 'string' ? cfg.apiBase.replace(/\/+$/, '') : '';
        let newSub = event.newSubscription || null;

        if (!newSub) {
          const keyRes = await fetch(`${base}/api/fcm/vapid-public-key`, { cache: 'no-store' });
          if (!keyRes.ok) return;
          const keyJson = await keyRes.json();
          if (!keyJson || !keyJson.publicKey) return;
          newSub = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlB64ToUint8Array(keyJson.publicKey),
          });
        }

        if (!newSub || !newSub.endpoint) return;
        const headers = Object.assign({ 'Content-Type': 'application/json' }, cfg.authHeaders || {});
        await fetch(`${base}/api/fcm/register`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            token: newSub.endpoint,
            deviceId: cfg.deviceId || 'web_sw',
            platform: 'web',
            subscription: typeof newSub.toJSON === 'function' ? newSub.toJSON() : newSub,
          }),
        });
        cfg.subscription = typeof newSub.toJSON === 'function' ? newSub.toJSON() : null;
        cfg.updatedAt = Date.now();
        await saveStandbyConfig(cfg);
      } catch {}
    })()
  );
});

const recentMessageIds = [];

self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    data = {
      title: 'Salim',
      body: event.data ? event.data.text() : 'وصلتك رسالة جديدة',
    };
  }

  const payloadData = data && typeof data.data === 'object' && data.data ? data.data : data;
  const messageId = payloadData && payloadData.messageId ? String(payloadData.messageId) : '';

  if (messageId) {
    if (recentMessageIds.includes(messageId)) {
      return;
    }
    recentMessageIds.push(messageId);
    if (recentMessageIds.length > 60) {
      recentMessageIds.shift();
    }
  }

  const title =
    payloadData.title ||
    data.title ||
    (data.notification && data.notification.title) ||
    'Salim';
  const body =
    payloadData.body ||
    data.body ||
    (data.notification && data.notification.body) ||
    'وصلتك رسالة جديدة';

  const resolvedChatType =
    payloadData.chatType === 'private' || payloadData.type === 'private_message'
      ? 'private'
      : 'channel';
  const resolvedPartnerId =
    resolvedChatType === 'private'
      ? Number(payloadData.partnerId || payloadData.senderId || 0) || payloadData.partnerId || payloadData.senderId || ''
      : '';

  const options = {
    body,
    icon: payloadData.icon || data.icon || '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    silent: false,
    requireInteraction: false,
    dir: 'rtl',
    lang: 'ar',
    timestamp: Number(payloadData.timestamp) || Date.now(),
    data: {
      chatType: resolvedChatType,
      channelId: resolvedChatType === 'channel' ? (payloadData.channelId || '') : '',
      partnerId: resolvedPartnerId,
      senderId: payloadData.senderId ? Number(payloadData.senderId) || payloadData.senderId : '',
      senderName: payloadData.senderName || '',
      messageId,
      fromNotification: true,
    },
    tag: messageId ? `salim-msg-${messageId}` : data.tag || `salim-msg-${Date.now()}`,
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = event.notification.data || {};
  const deepLinkParam = encodeURIComponent(JSON.stringify(notifData));
  const targetUrl = new URL(`/?salim_deeplink=${deepLinkParam}`, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      for (const client of clientList) {
        try {
          if (new URL(client.url).origin !== self.location.origin) continue;
        } catch {}
        if ('focus' in client) {
          const focused = await client.focus();
          (focused || client).postMessage({
            type: 'app_open_chat_message',
            detail: notifData,
          });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
