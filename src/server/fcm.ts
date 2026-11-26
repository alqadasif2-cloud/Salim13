import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import type webpushType from 'web-push';

const require = createRequire(import.meta.url);
const webpush = require('web-push') as typeof webpushType;
import {
  firestoreClient,
  getChannelById,
  getAllUsersList,
  isChannelOpenPublic,
  isFirestoreRestBackoffActive,
  handleFirestoreQuotaOrError,
} from './db.ts';
import { getMessaging } from 'firebase-admin/messaging';
import {
  getFirebaseAdminApp,
  adminFirestoreListCollection,
  adminFirestoreSetDoc,
  adminFirestoreDeleteDoc,
} from './gcpFirestoreAdmin.ts';

export interface WebPushSubscriptionData {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface DeviceRecord {
  id: string;
  token: string;
  userId: number | string;
  username?: string;
  deviceId: string;
  platform: 'web' | 'android' | string;
  deviceModel?: string;
  subscription?: WebPushSubscriptionData | null;
  updatedAt: number;
}

const DATA_DIR = path.resolve('data');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'push_subscriptions.json');
const VAPID_FILE = path.join(DATA_DIR, 'web_push_vapid.json');
const OUTBOX_FILE = path.join(DATA_DIR, 'push_outbox.json');
const PUSH_PREFS_FILE = path.join(DATA_DIR, 'push_prefs.json');
const NOTIFICATIONS_COLLECTION = 'community_notifications';
const PUSH_PREFS_COLLECTION = 'push_prefs';
const PUSH_OUTBOX_COLLECTION = 'push_outbox';

export interface NotificationPrefs {
  userId: number;
  mutedAll: boolean;
  mutedChannels: string[];
  mutedPartners: number[];
  updatedAt: number;
}

interface PushOutboxJob {
  jobId: string;
  dedupeKey: string;
  recordId: string;
  userId: number;
  platform: string;
  token: string;
  subscription: WebPushSubscriptionData | null;
  title: string;
  body: string;
  chatType: string;
  data: Record<string, string>;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  createdAt: number;
  lastError?: string;
}

const deviceTokens = new Map<string, DeviceRecord>();
const recentDispatchedMessages = new Map<string, number>();
const deliveredMessageTargets = new Map<string, number>();
const pushPrefsMap = new Map<number, NotificationPrefs>();
const pushOutboxQueue = new Map<string, PushOutboxJob>();

let vapidKeysCache: { publicKey: string; privateKey: string } | null = null;
let diskLoaded = false;
let prefsLoaded = false;
let outboxLoaded = false;
let outboxTimer: NodeJS.Timeout | null = null;
let outboxRunning = false;
let lastFirestoreSyncAt = 0;
let lastPrefsFirestoreSyncAt = 0;
let lastOutboxFirestoreSyncAt = 0;
const FIRESTORE_SYNC_TTL_MS = 15 * 1000;

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function makeFirestoreSafeId(raw: string): string {
  const clean = String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  if (clean.length > 0 && clean.length <= 120) return clean;
  return `job_${crypto.createHash('sha1').update(String(raw)).digest('hex')}`;
}

function loadPrefsFromDisk() {
  if (prefsLoaded) return;
  prefsLoaded = true;
  try {
    if (fs.existsSync(PUSH_PREFS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(PUSH_PREFS_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [uidStr, val] of Object.entries(parsed)) {
          const uid = Number(uidStr);
          if (uid > 0 && val && typeof val === 'object') {
            const p = val as any;
            pushPrefsMap.set(uid, {
              userId: uid,
              mutedAll: Boolean(p.mutedAll),
              mutedChannels: Array.isArray(p.mutedChannels) ? p.mutedChannels.map(String) : [],
              mutedPartners: Array.isArray(p.mutedPartners) ? p.mutedPartners.map(Number).filter((n: number) => n > 0) : [],
              updatedAt: Number(p.updatedAt || Date.now()),
            });
          }
        }
      }
    }
  } catch {}
}

function savePrefsToDisk() {
  try {
    ensureDataDir();
    const out: Record<string, NotificationPrefs> = {};
    for (const [uid, pref] of pushPrefsMap.entries()) {
      out[String(uid)] = pref;
    }
    fs.writeFileSync(PUSH_PREFS_FILE, JSON.stringify(out, null, 2), 'utf8');
  } catch {}
}

export async function syncPrefsFromFirestore(force = false): Promise<void> {
  loadPrefsFromDisk();
  if (isFirestoreRestBackoffActive()) return;
  if (!force && Date.now() - lastPrefsFirestoreSyncAt < 30_000) return;
  lastPrefsFirestoreSyncAt = Date.now();
  try {
    const docs = await adminFirestoreListCollection(PUSH_PREFS_COLLECTION, 500);
    let changed = false;
    for (const doc of docs) {
      const d = doc.data;
      if (!d) continue;
      const uid = Number(d.userId || 0);
      if (!uid || uid <= 0) continue;
      const updatedAt = Number(d.updatedAt || 0);
      const existing = pushPrefsMap.get(uid);
      if (!existing || updatedAt >= existing.updatedAt) {
        pushPrefsMap.set(uid, {
          userId: uid,
          mutedAll: Boolean(d.mutedAll),
          mutedChannels: Array.isArray(d.mutedChannels) ? d.mutedChannels.map(String) : [],
          mutedPartners: Array.isArray(d.mutedPartners)
            ? d.mutedPartners.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
            : [],
          updatedAt,
        });
        changed = true;
      }
    }
    if (changed) savePrefsToDisk();
  } catch (err) {
    handleFirestoreQuotaOrError(err, 'syncPrefsFromFirestore', PUSH_PREFS_COLLECTION);
  }
}

export function getUserNotificationPrefs(userId: number): NotificationPrefs {
  loadPrefsFromDisk();
  const uid = Number(userId || 0);
  return (
    pushPrefsMap.get(uid) || {
      userId: uid,
      mutedAll: false,
      mutedChannels: [],
      mutedPartners: [],
      updatedAt: 0,
    }
  );
}

export async function getUserNotificationPrefsAsync(userId: number): Promise<NotificationPrefs> {
  await syncPrefsFromFirestore();
  return getUserNotificationPrefs(userId);
}

export function saveUserNotificationPrefs(
  userId: number,
  patch: Partial<Omit<NotificationPrefs, 'userId'>>
): NotificationPrefs {
  loadPrefsFromDisk();
  const uid = Number(userId || 0);
  const current = getUserNotificationPrefs(uid);
  const next: NotificationPrefs = {
    userId: uid,
    mutedAll: patch.mutedAll !== undefined ? Boolean(patch.mutedAll) : current.mutedAll,
    mutedChannels: Array.isArray(patch.mutedChannels)
      ? Array.from(new Set(patch.mutedChannels.map(String).filter(Boolean)))
      : current.mutedChannels,
    mutedPartners: Array.isArray(patch.mutedPartners)
      ? Array.from(new Set(patch.mutedPartners.map(Number).filter((n) => Number.isFinite(n) && n > 0)))
      : current.mutedPartners,
    updatedAt: Date.now(),
  };
  pushPrefsMap.set(uid, next);
  savePrefsToDisk();
  if (!isFirestoreRestBackoffActive()) {
    adminFirestoreSetDoc(PUSH_PREFS_COLLECTION, `user_${uid}`, next).catch((err: any) =>
      handleFirestoreQuotaOrError(err, 'saveUserNotificationPrefs', PUSH_PREFS_COLLECTION)
    );
  }
  return next;
}

export async function saveUserNotificationPrefsAsync(
  userId: number,
  patch: Partial<Omit<NotificationPrefs, 'userId'>>
): Promise<NotificationPrefs> {
  await syncPrefsFromFirestore();
  const next = saveUserNotificationPrefs(userId, patch);
  if (!isFirestoreRestBackoffActive()) {
    try {
      await adminFirestoreSetDoc(PUSH_PREFS_COLLECTION, `user_${next.userId}`, next);
    } catch (err) {
      handleFirestoreQuotaOrError(err, 'saveUserNotificationPrefsAsync', PUSH_PREFS_COLLECTION);
    }
  }
  return next;
}

function isRecipientMuted(
  userId: number,
  chatType: string,
  channelId?: string,
  partnerOrSenderId?: number
): boolean {
  const pref = getUserNotificationPrefs(userId);
  if (pref.mutedAll) return true;
  if (chatType === 'channel' && channelId && pref.mutedChannels.includes(String(channelId))) {
    return true;
  }
  if (chatType === 'private' && partnerOrSenderId && pref.mutedPartners.includes(Number(partnerOrSenderId))) {
    return true;
  }
  return false;
}

function loadOutboxFromDisk() {
  if (outboxLoaded) return;
  outboxLoaded = true;
  try {
    if (fs.existsSync(OUTBOX_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8'));
      const now = Date.now();
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && item.jobId && now - Number(item.createdAt || now) < 24 * 60 * 60 * 1000) {
            pushOutboxQueue.set(String(item.jobId), item);
          }
        }
      }
    }
  } catch {}
  scheduleOutboxProcessor();
}

function saveOutboxToDisk() {
  try {
    ensureDataDir();
    const list = Array.from(pushOutboxQueue.values());
    fs.writeFileSync(OUTBOX_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch {}
}

function pruneDeliveredLog() {
  const now = Date.now();
  for (const [k, ts] of deliveredMessageTargets.entries()) {
    if (now - ts > 6 * 60 * 60 * 1000) {
      deliveredMessageTargets.delete(k);
    }
  }
}

function computeRetryDelayMs(attempt: number): number {
  const schedule = [10_000, 30_000, 90_000, 240_000, 600_000];
  return schedule[Math.min(Math.max(0, attempt - 1), schedule.length - 1)];
}

function persistOutboxJobToFirestore(job: PushOutboxJob) {
  if (isFirestoreRestBackoffActive()) return;
  const docId = makeFirestoreSafeId(job.jobId);
  adminFirestoreSetDoc(PUSH_OUTBOX_COLLECTION, docId, { ...job, firestoreDocId: docId }).catch((err: any) =>
    handleFirestoreQuotaOrError(err, 'persistOutboxJob', PUSH_OUTBOX_COLLECTION)
  );
}

function deleteOutboxJobFromFirestore(jobId: string) {
  if (isFirestoreRestBackoffActive()) return;
  const docId = makeFirestoreSafeId(jobId);
  adminFirestoreDeleteDoc(PUSH_OUTBOX_COLLECTION, docId).catch(() => {});
}

async function syncOutboxFromFirestore(force = false): Promise<void> {
  loadOutboxFromDisk();
  if (isFirestoreRestBackoffActive()) return;
  if (!force && Date.now() - lastOutboxFirestoreSyncAt < 30_000) return;
  lastOutboxFirestoreSyncAt = Date.now();
  try {
    const docs = await adminFirestoreListCollection(PUSH_OUTBOX_COLLECTION, 500);
    const now = Date.now();
    let changed = false;
    for (const doc of docs) {
      const item = doc.data;
      if (!item || !item.jobId) continue;
      if (now - Number(item.createdAt || now) >= 24 * 60 * 60 * 1000) {
        deleteOutboxJobFromFirestore(String(item.jobId));
        continue;
      }
      const key = String(item.jobId);
      const existing = pushOutboxQueue.get(key);
      if (!existing || Number(item.attempts || 0) >= existing.attempts) {
        pushOutboxQueue.set(key, item as PushOutboxJob);
        changed = true;
      }
    }
    if (changed) {
      saveOutboxToDisk();
      scheduleOutboxProcessor();
    }
  } catch (err) {
    handleFirestoreQuotaOrError(err, 'syncOutboxFromFirestore', PUSH_OUTBOX_COLLECTION);
  }
}

function enqueuePushOutboxJob(params: {
  recordId: string;
  userId: number;
  platform: string;
  token: string;
  subscription: WebPushSubscriptionData | null;
  title: string;
  body: string;
  chatType: string;
  data: Record<string, string>;
  errorMsg?: string;
}) {
  loadOutboxFromDisk();
  const msgId = params.data.messageId || '';
  const targetKey = params.subscription?.endpoint || params.token;
  if (!targetKey) return;
  const dedupeKey = msgId ? `${msgId}:${targetKey}` : `${Date.now()}:${targetKey}`;
  if (msgId && deliveredMessageTargets.has(dedupeKey)) {
    return;
  }
  const existing = pushOutboxQueue.get(dedupeKey);
  if (existing) {
    return;
  }
  const now = Date.now();
  const job: PushOutboxJob = {
    jobId: dedupeKey,
    dedupeKey,
    recordId: params.recordId,
    userId: params.userId,
    platform: params.platform,
    token: params.token,
    subscription: params.subscription,
    title: params.title,
    body: params.body,
    chatType: params.chatType,
    data: params.data,
    attempts: 1,
    maxAttempts: 5,
    nextAttemptAt: now + computeRetryDelayMs(1),
    createdAt: now,
    lastError: params.errorMsg,
  };
  pushOutboxQueue.set(dedupeKey, job);
  saveOutboxToDisk();
  persistOutboxJobToFirestore(job);
  scheduleOutboxProcessor();
}

function scheduleOutboxProcessor() {
  if (pushOutboxQueue.size === 0) {
    if (outboxTimer) {
      clearTimeout(outboxTimer);
      outboxTimer = null;
    }
    return;
  }
  if (outboxTimer) return;
  let earliest = Date.now() + 10_000;
  for (const job of pushOutboxQueue.values()) {
    if (job.nextAttemptAt < earliest) earliest = job.nextAttemptAt;
  }
  const waitMs = Math.max(2000, earliest - Date.now());
  outboxTimer = setTimeout(() => {
    outboxTimer = null;
    void processPushOutbox();
  }, waitMs);
  if (typeof outboxTimer.unref === 'function') {
    outboxTimer.unref();
  }
}

async function processPushOutbox(): Promise<void> {
  if (outboxRunning) return;
  loadOutboxFromDisk();
  if (pushOutboxQueue.size === 0) return;

  outboxRunning = true;
  try {
    loadVapidKeys();
    const now = Date.now();
    let changed = false;

    for (const [jobId, job] of Array.from(pushOutboxQueue.entries())) {
      if (job.nextAttemptAt > now) continue;
      if (now - job.createdAt > 24 * 60 * 60 * 1000) {
        pushOutboxQueue.delete(jobId);
        deleteOutboxJobFromFirestore(jobId);
        changed = true;
        continue;
      }
      if (job.data.messageId && deliveredMessageTargets.has(job.dedupeKey)) {
        pushOutboxQueue.delete(jobId);
        deleteOutboxJobFromFirestore(jobId);
        changed = true;
        continue;
      }

      if (job.subscription?.endpoint && job.subscription?.keys?.p256dh && job.subscription?.keys?.auth) {
        const webPayloadJson = JSON.stringify({
          title: job.title,
          body: job.body,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          dir: 'rtl',
          lang: 'ar',
          renotify: true,
          tag: job.data.messageId ? `salim-msg-${job.data.messageId}` : `salim-msg-${Date.now()}`,
          data: job.data,
        });
        try {
          await webpush.sendNotification(
            job.subscription as webpushType.PushSubscription,
            webPayloadJson,
            { TTL: 86400, urgency: 'high' }
          );
          if (job.data.messageId) {
            deliveredMessageTargets.set(job.dedupeKey, Date.now());
          }
          pushOutboxQueue.delete(jobId);
          deleteOutboxJobFromFirestore(jobId);
          changed = true;
        } catch (err: any) {
          const code = Number(err?.statusCode || 0);
          if (code === 401 || code === 403 || code === 404 || code === 410) {
            await removeDeviceRecord(job.recordId);
            pushOutboxQueue.delete(jobId);
            deleteOutboxJobFromFirestore(jobId);
          } else if (job.attempts >= job.maxAttempts) {
            pushOutboxQueue.delete(jobId);
            deleteOutboxJobFromFirestore(jobId);
          } else {
            job.attempts += 1;
            job.nextAttemptAt = Date.now() + computeRetryDelayMs(job.attempts);
            job.lastError = String(err?.message || code);
            persistOutboxJobToFirestore(job);
          }
          changed = true;
        }
      } else if (job.platform === 'android' && job.token && !job.token.startsWith('https://')) {
        const res = await sendAndroidFcmV1(job.token, {
          title: job.title,
          body: job.body,
          data: job.data,
        });
        if (res.ok) {
          if (job.data.messageId) {
            deliveredMessageTargets.set(job.dedupeKey, Date.now());
          }
          pushOutboxQueue.delete(jobId);
          deleteOutboxJobFromFirestore(jobId);
          changed = true;
        } else if (res.unreg) {
          await removeDeviceRecord(job.recordId);
          pushOutboxQueue.delete(jobId);
          deleteOutboxJobFromFirestore(jobId);
          changed = true;
        } else if (job.attempts >= job.maxAttempts) {
          pushOutboxQueue.delete(jobId);
          deleteOutboxJobFromFirestore(jobId);
          changed = true;
        } else {
          job.attempts += 1;
          job.nextAttemptAt = Date.now() + computeRetryDelayMs(job.attempts);
          job.lastError = res.error || 'fcm_retry';
          persistOutboxJobToFirestore(job);
          changed = true;
        }
      } else {
        pushOutboxQueue.delete(jobId);
        deleteOutboxJobFromFirestore(jobId);
        changed = true;
      }
    }

    if (changed) {
      saveOutboxToDisk();
    }
  } finally {
    outboxRunning = false;
    scheduleOutboxProcessor();
  }
}

export async function getPushSystemDiagnostics(forUserId?: number) {
  loadSubscriptionsFromDisk();
  await syncSubscriptionsFromFirestore();
  await syncOutboxFromFirestore();
  const devices = Array.from(deviceTokens.values());
  const androidCount = devices.filter((d) => d.platform === 'android').length;
  const webCount = devices.filter((d) => d.platform !== 'android').length;
  const uid = Number(forUserId || 0);
  const myDevices = uid > 0 && uid < 9_000_000 ? devices.filter((d) => Number(d.userId) === uid) : [];
  return {
    registeredDevices: deviceTokens.size,
    androidDevices: androidCount,
    webDevices: webCount,
    myWebDevices: myDevices.filter((d) => d.platform !== 'android').length,
    myAndroidDevices: myDevices.filter((d) => d.platform === 'android').length,
    pendingOutboxJobs: pushOutboxQueue.size,
    recentDeliveredCount: deliveredMessageTargets.size,
    vapidReady: Boolean(loadVapidKeys().publicKey),
    firestoreOutboxBacked: Boolean(firestoreClient),
  };
}

const FALLBACK_VAPID_KEYS = {
  publicKey: 'BAxCu1A3xvzXGjEkxI_7KBfy_29QNOzkWtFDSng5ejKgz7xducQIdFwL5-dS-PA7hj59XhyjvUGVELj1mtkufAU',
  privateKey: '1hm9M5iNdH33nSrciYVlnC8IrIbrE6-UlhBTU83waDw',
};

function loadVapidKeys(): { publicKey: string; privateKey: string } {
  if (vapidKeysCache) return vapidKeysCache;

  const envPub = (process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '').trim();
  const envPriv = (process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '').trim();
  if (envPub && envPriv) {
    vapidKeysCache = { publicKey: envPub, privateKey: envPriv };
  } else {
    ensureDataDir();
    if (fs.existsSync(VAPID_FILE)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
        if (parsed?.publicKey && parsed?.privateKey) {
          vapidKeysCache = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        }
      } catch {}
    }
    if (!vapidKeysCache) {
      vapidKeysCache = { ...FALLBACK_VAPID_KEYS };
      try {
        fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeysCache, null, 2), 'utf8');
      } catch (err) {
        console.warn('[Salim Push] Failed to persist VAPID keys:', err);
      }
    }
  }

  try {
    webpush.setVapidDetails(
      'mailto:notifications@salim-trading.app',
      vapidKeysCache.publicKey,
      vapidKeysCache.privateKey
    );
  } catch (err) {
    console.warn('[Salim Push] setVapidDetails warning:', err);
  }

  return vapidKeysCache;
}

export function getWebPushPublicKey(): string {
  return loadVapidKeys().publicKey;
}

function makeRecordKey(userId: number | string, deviceId: string, token: string): string {
  const cleanDev = String(deviceId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  if (cleanDev) {
    return `fcm_tok_${userId}_${cleanDev}`;
  }
  const hash = crypto.createHash('sha1').update(String(token)).digest('hex').slice(0, 12);
  return `fcm_tok_${userId}_${hash}`;
}

function loadSubscriptionsFromDisk() {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'));
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item && (item.token || item.subscription?.endpoint)) {
            const key =
              item.id || makeRecordKey(item.userId, item.deviceId || '', item.token || item.subscription?.endpoint);
            deviceTokens.set(key, { ...item, id: key });
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Salim Push] Failed to read disk push subscriptions:', err);
  }
}

function saveSubscriptionsToDisk() {
  try {
    ensureDataDir();
    const list = Array.from(deviceTokens.values());
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Salim Push] Failed to save disk push subscriptions:', err);
  }
}

async function syncSubscriptionsFromFirestore(): Promise<void> {
  loadSubscriptionsFromDisk();
  if (!firestoreClient || isFirestoreRestBackoffActive()) return;
  if (Date.now() - lastFirestoreSyncAt < FIRESTORE_SYNC_TTL_MS) return;
  lastFirestoreSyncAt = Date.now();

  try {
    const snap = await firestoreClient
      .collection(NOTIFICATIONS_COLLECTION)
      .where('type', '==', 'fcm_device_token')
      .get();

    let changed = false;
    snap.forEach((doc: { id: string; data: () => any }) => {
      const d = doc.data();
      if (!d) return;
      const uid = Number(d.userId || d.senderId || 0);
      if (!uid || uid <= 0) return;
      const sub: WebPushSubscriptionData | null =
        d.subscription && typeof d.subscription === 'object' && d.subscription.endpoint && d.subscription.keys
          ? {
              endpoint: String(d.subscription.endpoint),
              expirationTime: d.subscription.expirationTime ?? null,
              keys: {
                p256dh: String(d.subscription.keys.p256dh || ''),
                auth: String(d.subscription.keys.auth || ''),
              },
            }
          : null;
      const token = String(d.token || sub?.endpoint || '').trim();
      if (!token) return;

      const recordId = String(d.id || doc.id);
      const existing = deviceTokens.get(recordId);
      const updatedAt = Number(d.updatedAt || d.timestamp || Date.now());

      if (!existing || updatedAt >= existing.updatedAt) {
        deviceTokens.set(recordId, {
          id: recordId,
          token,
          userId: uid,
          username: String(d.username || d.senderName || ''),
          deviceId: String(d.deviceId || 'unknown'),
          platform: String(d.platform || (sub ? 'web' : 'android')),
          deviceModel: String(d.deviceModel || ''),
          subscription: sub || existing?.subscription || null,
          updatedAt,
        });
        changed = true;
      }
    });

    if (changed) {
      saveSubscriptionsToDisk();
    }
  } catch (err) {
    handleFirestoreQuotaOrError(err, 'syncSubscriptionsFromFirestore', NOTIFICATIONS_COLLECTION);
  }
}

async function removeDeviceRecord(recordId: string) {
  deviceTokens.delete(recordId);
  saveSubscriptionsToDisk();
  if (firestoreClient && !isFirestoreRestBackoffActive()) {
    try {
      await firestoreClient.collection(NOTIFICATIONS_COLLECTION).doc(recordId).delete();
    } catch {}
  }
}

export async function registerDeviceToken(params: {
  token?: string;
  userId: number | string;
  username?: string;
  deviceId?: string;
  platform?: string;
  deviceModel?: string;
  subscription?: WebPushSubscriptionData | null;
}): Promise<DeviceRecord> {
  loadSubscriptionsFromDisk();

  const uid = Number(params.userId || 0);
  const cleanSub: WebPushSubscriptionData | null =
    params.subscription &&
    typeof params.subscription === 'object' &&
    params.subscription.endpoint &&
    params.subscription.keys?.p256dh &&
    params.subscription.keys?.auth
      ? {
          endpoint: String(params.subscription.endpoint).trim(),
          expirationTime: params.subscription.expirationTime ?? null,
          keys: {
            p256dh: String(params.subscription.keys.p256dh).trim(),
            auth: String(params.subscription.keys.auth).trim(),
          },
        }
      : null;

  const cleanToken = String(params.token || cleanSub?.endpoint || '').trim();
  const cleanDeviceId = String(params.deviceId || 'web_default')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64);
  const platform = params.platform || (cleanSub ? 'web' : 'android');
  const recordId = makeRecordKey(uid, cleanDeviceId, cleanToken);
  const now = Date.now();

  // Remove stale registrations on the same deviceId or endpoint belonging to another user
  const staleIds: string[] = [];
  for (const [key, rec] of deviceTokens.entries()) {
    if (key === recordId) continue;
    const sameDevice = rec.deviceId && cleanDeviceId && rec.deviceId === cleanDeviceId;
    const sameEndpoint =
      cleanSub?.endpoint &&
      (rec.subscription?.endpoint === cleanSub.endpoint || rec.token === cleanSub.endpoint);
    const sameToken = cleanToken && rec.token === cleanToken;
    if (sameDevice || sameEndpoint || sameToken) {
      staleIds.push(key);
    }
  }
  for (const staleKey of staleIds) {
    await removeDeviceRecord(staleKey);
  }

  const record: DeviceRecord = {
    id: recordId,
    token: cleanToken,
    userId: uid,
    username: params.username || '',
    deviceId: cleanDeviceId,
    platform,
    deviceModel: params.deviceModel || '',
    subscription: cleanSub,
    updatedAt: now,
  };

  deviceTokens.set(recordId, record);
  saveSubscriptionsToDisk();

  if (firestoreClient && !isFirestoreRestBackoffActive()) {
    try {
      await firestoreClient
        .collection(NOTIFICATIONS_COLLECTION)
        .doc(recordId)
        .set(
          {
            id: recordId,
            type: 'fcm_device_token',
            title: 'fcm_token',
            body: '',
            token: cleanToken,
            userId: uid,
            senderId: uid,
            username: params.username || '',
            senderName: params.username || '',
            deviceId: cleanDeviceId,
            platform,
            deviceModel: params.deviceModel || '',
            subscription: cleanSub || null,
            targetUserIds: [],
            timestamp: now,
            updatedAt: now,
            createdAt: now,
          },
          { merge: true }
        );
    } catch (err) {
      handleFirestoreQuotaOrError(err, 'registerDeviceToken', NOTIFICATIONS_COLLECTION);
    }
  }

  return record;
}

export async function unregisterDeviceToken(
  userId: number | string,
  token?: string,
  deviceId?: string
): Promise<void> {
  loadSubscriptionsFromDisk();
  const uid = Number(userId || 0);
  const toDelete: string[] = [];

  for (const [key, rec] of deviceTokens.entries()) {
    const matchesUser = uid > 0 ? Number(rec.userId) === uid : true;
    const matchesToken = token && (rec.token === token || rec.subscription?.endpoint === token);
    const matchesDev = deviceId && rec.deviceId === deviceId;
    if (matchesUser && (matchesToken || matchesDev || (!token && !deviceId))) {
      toDelete.push(key);
    }
  }

  for (const key of toDelete) {
    await removeDeviceRecord(key);
  }
}

function resolveAndroidChannelId(data: Record<string, string>): string {
  if (data.type === 'app_update') return 'sami_app_updates_v2';
  if (data.chatType === 'private') return 'sami_private_messages_v2';
  return 'sami_channel_messages_v2';
}

async function sendAndroidFcmV1(
  fcmToken: string,
  payload: {
    title: string;
    body: string;
    data: Record<string, string>;
  }
): Promise<{ ok: boolean; unreg?: boolean; transient?: boolean; error?: string }> {
  const adminApp = getFirebaseAdminApp();
  if (!adminApp) {
    return { ok: false, transient: false, error: 'firebase_admin_adc_unavailable' };
  }

  const androidChannelId = resolveAndroidChannelId(payload.data);

  try {
    await getMessaging(adminApp).send({
      token: fcmToken,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data,
      android: {
        priority: 'high',
        ttl: 86400 * 1000,
        collapseKey:
          payload.data.chatType === 'private'
            ? `salim_pm_${payload.data.partnerId || payload.data.senderId || 'chat'}`
            : `salim_ch_${payload.data.channelId || 'general'}`,
        notification: {
          channelId: androidChannelId,
          clickAction: 'OPEN_SAMI_CHAT',
          priority: 'high',
          visibility: 'public',
          defaultSound: true,
          defaultVibrateTimings: true,
          tag: payload.data.messageId ? `salim-msg-${payload.data.messageId}` : undefined,
        },
      },
    });

    return { ok: true };
  } catch (err: any) {
    const code = String(err?.code || '');
    const msg = String(err?.message || code || 'fcm_admin_error');
    console.warn(`[Salim FCM Admin SDK] Delivery failed (${code}): ${msg.slice(0, 180)}`);

    const isPermissionOrAuthError =
      code === 'messaging/authentication-error' ||
      code === 'messaging/third-party-auth-error' ||
      msg.includes('PERMISSION_DENIED') ||
      msg.includes('cloudmessaging.messages.create') ||
      msg.includes('403') ||
      msg.includes('401');

    if (isPermissionOrAuthError) {
      return { ok: false, transient: false, error: code || 'fcm_permission_denied' };
    }

    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/sender-id-mismatch' ||
      msg.includes('UNREGISTERED') ||
      msg.includes('Requested entity was not found') ||
      msg.includes('MismatchSenderId')
    ) {
      return { ok: false, unreg: true, error: code || msg.slice(0, 160) };
    }

    const isTransient =
      code === 'messaging/server-unavailable' ||
      code === 'messaging/internal-error' ||
      code === 'messaging/quota-exceeded' ||
      msg.includes('500') ||
      msg.includes('503') ||
      msg.includes('429') ||
      msg.includes('timeout') ||
      msg.includes('ECONN');

    return { ok: false, transient: isTransient, error: code || msg.slice(0, 160) };
  }
}

export async function sendNotificationToUsers(
  targetUserIds: (number | string)[],
  payload: {
    title: string;
    body: string;
    chatType?: string;
    data?: Record<string, string>;
  }
): Promise<{ success: boolean; sentCount: number; queuedCount?: number }> {
  loadVapidKeys();
  loadOutboxFromDisk();
  pruneDeliveredLog();
  await syncSubscriptionsFromFirestore();
  await syncOutboxFromFirestore();

  const targetSet = new Set(
    (targetUserIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
  );
  const broadcastAll = targetSet.size === 0;

  const stringData: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload.data || {})) {
    if (v !== undefined && v !== null) {
      stringData[k] = String(v);
    }
  }
  stringData.title = payload.title;
  stringData.body = payload.body;
  if (payload.chatType && !stringData.chatType) {
    stringData.chatType = payload.chatType;
  }
  if (!stringData.timestamp) {
    stringData.timestamp = String(Date.now());
  }

  const webPayloadJson = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    dir: 'rtl',
    lang: 'ar',
    renotify: true,
    tag: stringData.messageId ? `salim-msg-${stringData.messageId}` : `salim-msg-${Date.now()}`,
    data: stringData,
  });

  const matchingDevices = Array.from(deviceTokens.values()).filter((rec) => {
    const uid = Number(rec.userId || 0);
    return broadcastAll ? uid > 0 : targetSet.has(uid);
  });

  // Deduplicate by endpoint/token so same physical device doesn't get double alerts
  const seenEndpoints = new Set<string>();
  const uniqueDevices: DeviceRecord[] = [];
  for (const rec of matchingDevices) {
    const key = rec.subscription?.endpoint || rec.token;
    if (!key || seenEndpoints.has(key)) continue;
    seenEndpoints.add(key);
    uniqueDevices.push(rec);
  }

  let sentCount = 0;
  let queuedCount = 0;
  const msgId = stringData.messageId || '';

  await Promise.allSettled(
    uniqueDevices.map(async (rec) => {
      const targetKey = rec.subscription?.endpoint || rec.token;
      const dedupeKey = msgId ? `${msgId}:${targetKey}` : '';
      if (dedupeKey && deliveredMessageTargets.has(dedupeKey)) {
        return;
      }

      if (rec.subscription?.endpoint && rec.subscription?.keys?.p256dh && rec.subscription?.keys?.auth) {
        try {
          await webpush.sendNotification(
            rec.subscription as webpushType.PushSubscription,
            webPayloadJson,
            {
              TTL: 86400,
              urgency: 'high',
            }
          );
          if (dedupeKey) deliveredMessageTargets.set(dedupeKey, Date.now());
          sentCount += 1;
        } catch (err: any) {
          const code = Number(err?.statusCode || 0);
          if (code === 401 || code === 403 || code === 404 || code === 410) {
            await removeDeviceRecord(rec.id);
          } else {
            enqueuePushOutboxJob({
              recordId: rec.id,
              userId: Number(rec.userId),
              platform: rec.platform || 'web',
              token: rec.token,
              subscription: rec.subscription,
              title: payload.title,
              body: payload.body,
              chatType: stringData.chatType || 'channel',
              data: stringData,
              errorMsg: String(err?.message || code),
            });
            queuedCount += 1;
            console.warn('[Salim WebPush] Queued for retry:', code, err?.message || err);
          }
        }
        return;
      }

      if (rec.platform === 'android' && rec.token && !rec.token.startsWith('https://')) {
        const res = await sendAndroidFcmV1(rec.token, {
          title: payload.title,
          body: payload.body,
          data: stringData,
        });
        if (res.ok) {
          if (dedupeKey) deliveredMessageTargets.set(dedupeKey, Date.now());
          sentCount += 1;
        } else if (res.unreg) {
          await removeDeviceRecord(rec.id);
        } else if (res.transient) {
          enqueuePushOutboxJob({
            recordId: rec.id,
            userId: Number(rec.userId),
            platform: 'android',
            token: rec.token,
            subscription: null,
            title: payload.title,
            body: payload.body,
            chatType: stringData.chatType || 'channel',
            data: stringData,
            errorMsg: res.error,
          });
          queuedCount += 1;
        }
      }
    })
  );

  return { success: true, sentCount, queuedCount };
}

export async function dispatchAuthorizedChatPush(params: {
  senderId: number | string;
  senderName: string;
  senderRole?: string;
  title?: string;
  chatType: 'private' | 'channel';
  channelId?: string;
  receiverId?: number | string;
  partnerId?: number | string;
  targetUserIds?: (number | string)[];
  messageId: string;
  snippet: string;
}): Promise<{ success: boolean; deliveredCount: number; queuedCount?: number }> {
  const now = Date.now();
  // Clean old dedupe entries
  for (const [msgKey, ts] of recentDispatchedMessages.entries()) {
    if (now - ts > 120_000) recentDispatchedMessages.delete(msgKey);
  }
  const dedupeKey = params.messageId ? `${params.chatType}:${params.messageId}` : '';
  if (dedupeKey) {
    if (recentDispatchedMessages.has(dedupeKey)) {
      return { success: true, deliveredCount: 0 };
    }
    recentDispatchedMessages.set(dedupeKey, now);
  }

  const senderNum = Number(params.senderId || 0);
  const isPrivate = params.chatType === 'private';

  // Authoritatively compute eligible recipients from DB records
  let recipients: number[] = [];

  try {
    const allUsers = await getAllUsersList();
    const activeUserIds = new Set<number>();
    for (const u of allUsers) {
      const uid = Number(u.id || 0);
      const anyU = u as any;
      if (uid > 0 && !anyU.banned && !anyU.disabled && !anyU.isDeleted && !anyU.deleted) {
        activeUserIds.add(uid);
      }
    }

    if (isPrivate) {
      const rawReceiver = Number(
        params.receiverId ||
          (Array.isArray(params.targetUserIds) && params.targetUserIds.length === 1
            ? params.targetUserIds[0]
            : 0)
      );
      if (rawReceiver > 0 && rawReceiver < 9_000_000 && rawReceiver !== senderNum) {
        recipients = [rawReceiver];
      }
    } else if (params.channelId) {
      loadSubscriptionsFromDisk();
      await syncSubscriptionsFromFirestore();
      const channel = await getChannelById(params.channelId);
      const clientTargetIds = Array.isArray(params.targetUserIds)
        ? params.targetUserIds.map((id) => Number(id)).filter((id) => id > 0 && id < 9_000_000 && id !== senderNum)
        : [];
      const subscribedUserIds = Array.from(deviceTokens.values())
        .map((d) => Number(d.userId || 0))
        .filter((id) => id > 0 && id < 9_000_000 && id !== senderNum);

      if (channel) {
        if (isChannelOpenPublic(channel)) {
          recipients = Array.from(
            new Set<number>([...activeUserIds, ...subscribedUserIds, ...clientTargetIds])
          ).filter((id) => id > 0 && id < 9_000_000 && id !== senderNum);
        } else {
          const allowedSet = new Set<number>(
            (channel.allowedMemberIds || []).map((id) => Number(id)).filter((id) => id > 0)
          );
          for (const u of allUsers) {
            const uid = Number(u.id || 0);
            if (uid > 0 && (u.role === 'owner' || uid === 1 || uid === 76 || uid === 77)) {
              allowedSet.add(uid);
            }
          }
          recipients = Array.from(allowedSet).filter(
            (id) =>
              id > 0 &&
              id < 9_000_000 &&
              id !== senderNum &&
              (activeUserIds.size === 0 || activeUserIds.has(id) || subscribedUserIds.includes(id))
          );
        }
      } else if (clientTargetIds.length > 0) {
        recipients = Array.from(new Set<number>(clientTargetIds));
      } else {
        recipients = Array.from(new Set<number>([...activeUserIds, ...subscribedUserIds])).filter(
          (id) => id > 0 && id < 9_000_000 && id !== senderNum
        );
      }
    }
  } catch {
    if (isPrivate && params.receiverId) {
      const rNum = Number(params.receiverId);
      if (rNum > 0 && rNum !== senderNum) recipients = [rNum];
    } else if (Array.isArray(params.targetUserIds) && params.targetUserIds.length > 0) {
      recipients = params.targetUserIds
        .map((id) => Number(id))
        .filter((id) => id > 0 && id < 9_000_000 && id !== senderNum);
    }
  }

  // Hydrate persistent mute prefs from Firestore before filtering
  await syncPrefsFromFirestore();

  // Enforce per-user mute preferences before dispatching
  recipients = recipients.filter(
    (uid) => !isRecipientMuted(uid, params.chatType, params.channelId, senderNum)
  );

  if (recipients.length === 0) {
    return { success: true, deliveredCount: 0, queuedCount: 0 };
  }

  const pushTitle = params.title || params.senderName || 'Salim';
  const pushBody = params.snippet || 'رسالة جديدة';

  const result = await sendNotificationToUsers(recipients, {
    title: pushTitle,
    body: pushBody,
    chatType: params.chatType,
    data: {
      chatType: params.chatType,
      channelId: !isPrivate && params.channelId ? String(params.channelId) : '',
      partnerId: isPrivate ? String(params.partnerId || senderNum || '') : '',
      senderId: String(senderNum || ''),
      senderName: String(params.senderName || 'Salim'),
      messageId: String(params.messageId || ''),
    },
  });

  return {
    success: true,
    deliveredCount: result.sentCount,
    queuedCount: result.queuedCount || 0,
  };
}

export async function sendTestPushToUser(
  userId: number,
  customBody?: string
): Promise<{ success: boolean; sentCount: number; queuedCount: number }> {
  const uid = Number(userId || 0);
  if (!uid || uid <= 0 || uid >= 9_000_000) {
    return { success: false, sentCount: 0, queuedCount: 0 };
  }
  const msgId = `test_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const res = await sendNotificationToUsers([uid], {
    title: '👑 اختبار إشعارات Salim',
    body: customBody || 'تم استلام الإشعار بنجاح! جهازك الآن يستقبل الرسائل حتى عند قفل الشاشة.',
    chatType: 'channel',
    data: {
      chatType: 'channel',
      channelId: 'general_trading',
      senderId: '1',
      senderName: 'Salim',
      messageId: msgId,
    },
  });
  return {
    success: res.success,
    sentCount: res.sentCount,
    queuedCount: res.queuedCount || 0,
  };
}
