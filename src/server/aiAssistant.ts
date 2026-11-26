import crypto from 'crypto';
import { GoogleGenAI, Type, type Content, type FunctionDeclaration } from '@google/genai';
import type { AuthUser } from './auth.ts';
import {
  addChannelMembers,
  databaseId,
  deleteChannelRecord,
  deleteUserRecord,
  firestoreClient,
  getAiAssistantDiskStore,
  getAllUsersList,
  getChannelById,
  getChannelMembersDetails,
  getChannelMessages,
  getChannelsForUser,
  getUserById,
  getUserChallenge,
  getUserTrades,
  projectId,
  removeChannelMember,
  saveAiAssistantDiskStore,
  saveChannelMessage,
  saveChannelRecord,
  savePrivateMessageRecord,
  togglePinChannelMessage,
  updateUserRecord,
  type ChannelMessage,
  type ChannelRecord,
} from './db.ts';
import { dispatchAuthorizedChatPush } from './fcm.ts';
import {
  createUsersBatchViaAssistant,
  deleteRegularUserByAssistant,
  isProtectedOwnerOrSystemUser,
  updateRegularUserByAssistant,
  type CreatedUserCredential,
} from './ownerUserAdmin.ts';
import { generateInternalYemeniPersonas } from './internalYemeniEngine.ts';

const OWNER_ID = 1;
const OWNER_USERNAME = 'Salim';
const OWNER_THREAD_ID = 'owner_salim_1';
const GEMINI_MODEL = 'gemini-4-hydrogen';

const AI_FIRESTORE_PROBE_TTL_MS = 10 * 60 * 1000;
let firestoreAiPermWarningLogged = false;
let aiFirestoreSyncCache: { allowed: boolean; checkedAt: number } | null = null;
let aiFirestoreProbeInFlight: Promise<boolean> | null = null;

export interface GeminiEngineStatus {
  mode: 'gemini' | 'internal_fallback';
  cooldownUntil: number;
  cooldownMs: number;
  consecutiveFailures: number;
  lastErrorReason: string | null;
  lastSuccessAt: number | null;
  lastSwitchAt: number | null;
}

const DEFAULT_GEMINI_COOLDOWN_MS = 60 * 1000;
const geminiHealthState: GeminiEngineStatus = {
  mode: 'gemini',
  cooldownUntil: 0,
  cooldownMs: DEFAULT_GEMINI_COOLDOWN_MS,
  consecutiveFailures: 0,
  lastErrorReason: null,
  lastSuccessAt: null,
  lastSwitchAt: null,
};

type GeminiGenerateFn = (params: any) => Promise<any>;
let geminiGenerateOverrideForTest: GeminiGenerateFn | null = null;
let forcedInternalFallbackForTest = false;

export function getGeminiEngineStatus(): GeminiEngineStatus {
  return { ...geminiHealthState };
}

export function setGeminiTestingHooksForTest(opts: {
  generateOverride?: GeminiGenerateFn | null;
  cooldownMs?: number;
  forceFallback?: boolean;
}): void {
  if (opts.generateOverride !== undefined) {
    geminiGenerateOverrideForTest = opts.generateOverride;
  }
  if (opts.cooldownMs !== undefined && Number.isFinite(opts.cooldownMs) && opts.cooldownMs >= 0) {
    geminiHealthState.cooldownMs = opts.cooldownMs;
  }
  if (opts.forceFallback !== undefined) {
    forcedInternalFallbackForTest = Boolean(opts.forceFallback);
  }
}

export function resetGeminiEngineStateForTest(): void {
  geminiHealthState.mode = 'gemini';
  geminiHealthState.cooldownUntil = 0;
  geminiHealthState.cooldownMs = DEFAULT_GEMINI_COOLDOWN_MS;
  geminiHealthState.consecutiveFailures = 0;
  geminiHealthState.lastErrorReason = null;
  geminiHealthState.lastSuccessAt = null;
  geminiHealthState.lastSwitchAt = null;
  geminiGenerateOverrideForTest = null;
  forcedInternalFallbackForTest = false;
}

export interface AiToolStep {
  toolName: string;
  labelAr: string;
  status: 'ok' | 'pending_confirmation' | 'error';
  summaryAr: string;
}

export interface AiNavigationDirective {
  tab: 'dashboard' | 'channels' | 'private_chat' | 'admin' | 'history' | 'roadmap' | 'settings' | 'ai_assistant';
  channelId?: string | null;
  channelName?: string | null;
  partnerId?: number | null;
  partnerName?: string | null;
  messageId?: string | null;
}

export interface AiAssistantThread {
  id: string;
  ownerId: number;
  ownerUsername: string;
  activeSection: string | null;
  activeChannelId: string | null;
  activeChannelName: string | null;
  activePartnerId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AiAssistantMessage {
  id: string;
  threadId: string;
  ownerId: number;
  ownerUsername: string;
  role: 'user' | 'assistant';
  text: string;
  toolSteps?: AiToolStep[] | null;
  draftId?: string | null;
  pendingActionId?: string | null;
  navigation?: AiNavigationDirective | null;
  createdAccounts?: CreatedUserCredential[] | null;
  timestamp: number;
}

export interface VirtualPersonaDraftItem {
  id: string;
  userId?: number;
  username?: string;
  avatarUrl?: string | null;
  personaName: string;
  dialect: string;
  styleTag: string;
  text: string;
}

export interface AiAssistantDraft {
  id: string;
  ownerId: number;
  ownerUsername: string;
  channelId: string;
  channelName: string;
  topic: string;
  status: 'pending_approval' | 'publishing' | 'published' | 'cancelled';
  items: VirtualPersonaDraftItem[];
  intervalSeconds?: number;
  nextPublishAt?: number | null;
  publishedCount?: number;
  createdAt: number;
  updatedAt: number;
}

const activeDraftTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function clampIntervalSeconds(val: unknown): number {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.max(0, Math.min(3600, Math.round(num)));
}

export interface AiAssistantPendingAction {
  id: string;
  ownerId: number;
  ownerUsername: string;
  actionType:
    | 'send_channel_message'
    | 'send_private_message'
    | 'create_channel'
    | 'update_channel'
    | 'delete_channel'
    | 'manage_channel_members'
    | 'manage_user'
    | 'pin_channel_message'
    | 'choose_interaction_accounts';
  titleAr: string;
  summaryAr: string;
  payload: Record<string, any>;
  status: 'pending' | 'executed' | 'cancelled';
  resultMessage?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AiAssistantAuditLog {
  id: string;
  ownerId: number;
  ownerUsername: string;
  actionType: string;
  command: string;
  target: string;
  status: 'success' | 'pending' | 'cancelled' | 'error';
  details: string;
  timestamp: number;
}

export function isMainOwnerIdentity(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  if (Number(user.id) !== OWNER_ID) return false;
  if (user.isRestrictedAdmin) return false;
  if (String(user.role || '').toLowerCase() !== 'owner') return false;
  return String(user.username || '').trim().toLowerCase() === 'salim';
}

export async function verifyMainOwnerLive(authUser: AuthUser | undefined, _verifiedByJwt?: boolean | undefined): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!authUser) {
    return {
      ok: false,
      status: 401,
      error: 'يرجى تسجيل الدخول بحساب القائد Salim أولاً.',
    };
  }
  if (!isMainOwnerIdentity(authUser)) {
    return {
      ok: false,
      status: 403,
      error: 'هذا القسم حصري تماماً لحساب المالك الرئيسي (salim) فقط.',
    };
  }
  const dbUser = await getUserById(OWNER_ID);
  if (
    !dbUser ||
    Number(dbUser.id) !== OWNER_ID ||
    dbUser.isRestrictedAdmin ||
    dbUser.role !== 'owner' ||
    String(dbUser.username || '').trim().toLowerCase() !== 'salim'
  ) {
    return {
      ok: false,
      status: 403,
      error: 'تعذر التحقق من صلاحية حساب المالك الرئيسي في قاعدة البيانات.',
    };
  }
  return { ok: true, status: 200 };
}

export class GeminiRateLimitError extends Error {
  status = 429;
  code = 'GEMINI_RATE_LIMIT';
  constructor(message: string) {
    super(message);
    this.name = 'GeminiRateLimitError';
  }
}

export class GeminiConfigError extends Error {
  status = 503;
  code = 'GEMINI_CONFIG_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'GeminiConfigError';
  }
}

function classifyGeminiError(err: unknown): {
  isRateLimit: boolean;
  isAuthOrKey: boolean;
  isNotFound: boolean;
  isTransient: boolean;
  messageAr: string;
} {
  const anyErr = err as any;
  const status = Number(anyErr?.status || anyErr?.code || anyErr?.error?.code || 0);
  const statusText = String(anyErr?.statusText || anyErr?.error?.status || '').toUpperCase();
  const rawMsg = err instanceof Error ? err.message : String(err || '');
  const combined = `${status} ${statusText} ${rawMsg}`.toLowerCase();

  const isRateLimit =
    status === 429 ||
    combined.includes('429') ||
    combined.includes('resource_exhausted') ||
    combined.includes('rate limit') ||
    combined.includes('too many requests') ||
    combined.includes('quota');

  if (isRateLimit) {
    return {
      isRateLimit: true,
      isAuthOrKey: false,
      isNotFound: false,
      isTransient: true,
      messageAr: 'تم بلوغ حد حصة Gemini API (429 / RESOURCE_EXHAUSTED).',
    };
  }

  const isAuthOrKey =
    status === 401 ||
    status === 403 ||
    combined.includes('permission_denied') ||
    combined.includes('api_key_invalid') ||
    combined.includes('gemini_api_key');

  if (isAuthOrKey) {
    return {
      isRateLimit: false,
      isAuthOrKey: true,
      isNotFound: false,
      isTransient: false,
      messageAr: 'مفتاح GEMINI_API_KEY غير مهيأ أو غير صالح.',
    };
  }

  const isNotFound = status === 404 || combined.includes('not_found');
  if (isNotFound) {
    return {
      isRateLimit: false,
      isAuthOrKey: false,
      isNotFound: true,
      isTransient: false,
      messageAr: `النموذج المطلوب (${GEMINI_MODEL}) غير متاح حالياً في Gemini API.`,
    };
  }

  const isTransient =
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    combined.includes('fetch') ||
    combined.includes('network') ||
    combined.includes('timeout') ||
    combined.includes('econn') ||
    combined.includes('unavailable') ||
    combined.includes('overloaded');

  return {
    isRateLimit: false,
    isAuthOrKey: false,
    isNotFound: false,
    isTransient,
    messageAr: rawMsg || 'تعذر الاتصال بـ Gemini API.',
  };
}

class GeminiFallbackSignalError extends Error {
  reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'GeminiFallbackSignalError';
    this.reason = reason;
  }
}

function isGeminiAvailableNow(): boolean {
  if (forcedInternalFallbackForTest) return false;
  const hasKey = Boolean(geminiGenerateOverrideForTest || String(process.env.GEMINI_API_KEY || '').trim());
  if (!hasKey) return false;
  return Date.now() >= geminiHealthState.cooldownUntil;
}

function tripGeminiFallback(reason: string): void {
  const now = Date.now();
  geminiHealthState.mode = 'internal_fallback';
  geminiHealthState.cooldownUntil = now + Math.max(0, geminiHealthState.cooldownMs);
  geminiHealthState.consecutiveFailures += 1;
  geminiHealthState.lastErrorReason = reason;
  geminiHealthState.lastSwitchAt = now;
  console.warn(`[Salim AI] Auto-switched to internal Yemeni engine (reason: ${reason}). Cooldown ${geminiHealthState.cooldownMs}ms.`);
}

function recordGeminiSuccess(): void {
  const wasFallback = geminiHealthState.mode === 'internal_fallback';
  geminiHealthState.mode = 'gemini';
  geminiHealthState.cooldownUntil = 0;
  geminiHealthState.consecutiveFailures = 0;
  geminiHealthState.lastErrorReason = null;
  geminiHealthState.lastSuccessAt = Date.now();
  if (wasFallback) {
    console.info('[Salim AI] Gemini API quota/availability restored; auto-resumed Gemini engine.');
  }
}

async function invokeGeminiGenerate(params: any): Promise<any> {
  if (!isGeminiAvailableNow()) {
    throw new GeminiFallbackSignalError(
      geminiHealthState.lastErrorReason || 'النظام يعمل حالياً بالمحرك الداخلي مؤقتاً.'
    );
  }
  try {
    const res = geminiGenerateOverrideForTest
      ? await geminiGenerateOverrideForTest(params)
      : await getGeminiClient().models.generateContent(params);
    recordGeminiSuccess();
    return res;
  } catch (err) {
    const info = classifyGeminiError(err);
    tripGeminiFallback(info.messageAr);
    throw new GeminiFallbackSignalError(info.messageAr);
  }
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new GeminiConfigError(
      'مفتاح GEMINI_API_KEY غير مهيأ في Settings > Secrets. الأوامر الإدارية المباشرة تعمل بدون Gemini.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function sanitizeNoBannedAiDisclaimer(text: string): string {
  return String(text || '')
    .replace(/مول[ّ]?د\s*بالذكاء\s*الاصطناعي/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeArabicForMatch(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u064B-\u065F]/g, '');
}

function logAiFirestoreError(operationType: 'write' | 'delete', path: string, error: unknown): void {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
  };
  console.warn('[Salim AI] Firestore sync notice:', JSON.stringify(errInfo));
}

async function canSyncAiFirestore(): Promise<boolean> {
  if (!firestoreClient || !projectId) return false;
  const now = Date.now();
  if (aiFirestoreSyncCache && now - aiFirestoreSyncCache.checkedAt < AI_FIRESTORE_PROBE_TTL_MS) {
    return aiFirestoreSyncCache.allowed;
  }
  if (aiFirestoreProbeInFlight) {
    return aiFirestoreProbeInFlight;
  }

  aiFirestoreProbeInFlight = (async () => {
    try {
      const dbSegment = databaseId && databaseId.trim() ? databaseId.trim() : '(default)';
      const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(dbSegment)}/documents/ai_assistant_threads/${encodeURIComponent(OWNER_THREAD_ID)}`;
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (res.status === 200 || res.status === 404) {
        aiFirestoreSyncCache = { allowed: true, checkedAt: Date.now() };
        return true;
      }

      if (res.status === 401 || res.status === 403) {
        aiFirestoreSyncCache = { allowed: false, checkedAt: Date.now() };
        if (!firestoreAiPermWarningLogged) {
          firestoreAiPermWarningLogged = true;
          console.warn('[Salim AI] Firestore ai_assistant_* rules not yet deployed on project; persisting securely on server store without gRPC writes.');
        }
        return false;
      }

      // Transient non-200/404/403 status: avoid gRPC write spam and re-probe after 1 minute
      aiFirestoreSyncCache = {
        allowed: false,
        checkedAt: Date.now() - (AI_FIRESTORE_PROBE_TTL_MS - 60 * 1000),
      };
      return false;
    } catch {
      aiFirestoreSyncCache = {
        allowed: false,
        checkedAt: Date.now() - (AI_FIRESTORE_PROBE_TTL_MS - 60 * 1000),
      };
      return false;
    } finally {
      aiFirestoreProbeInFlight = null;
    }
  })();

  return aiFirestoreProbeInFlight;
}

async function tryWriteFirestoreDoc(collection: string, docId: string, data: Record<string, any>): Promise<void> {
  if (!(await canSyncAiFirestore())) return;
  const docPath = `${collection}/${docId}`;
  try {
    await firestoreClient.collection(collection).doc(docId).set(data, { merge: true });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.includes('permission') || msg.includes('PERMISSION_DENIED') || msg.includes('permission-denied')) {
      aiFirestoreSyncCache = { allowed: false, checkedAt: Date.now() };
      if (!firestoreAiPermWarningLogged) {
        firestoreAiPermWarningLogged = true;
        console.warn('[Salim AI] Firestore ai_assistant_* rules not yet deployed on project; persisting securely on server store.');
      }
    } else {
      logAiFirestoreError('write', docPath, err);
    }
  }
}

async function tryDeleteFirestoreDoc(collection: string, docId: string): Promise<void> {
  if (!(await canSyncAiFirestore())) return;
  const docPath = `${collection}/${docId}`;
  try {
    await firestoreClient.collection(collection).doc(docId).delete();
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.includes('permission') || msg.includes('PERMISSION_DENIED') || msg.includes('permission-denied')) {
      aiFirestoreSyncCache = { allowed: false, checkedAt: Date.now() };
    } else {
      logAiFirestoreError('delete', docPath, err);
    }
  }
}

function ensureThread(): AiAssistantThread {
  const store = getAiAssistantDiskStore();
  let t = store.threads?.[OWNER_THREAD_ID] as AiAssistantThread | undefined;
  if (!t) {
    const now = Date.now();
    t = {
      id: OWNER_THREAD_ID,
      ownerId: OWNER_ID,
      ownerUsername: OWNER_USERNAME,
      activeSection: 'ai_assistant',
      activeChannelId: null,
      activeChannelName: null,
      activePartnerId: null,
      createdAt: now,
      updatedAt: now,
    };
    store.threads![OWNER_THREAD_ID] = t;
    saveAiAssistantDiskStore();
    void tryWriteFirestoreDoc('ai_assistant_threads', t.id, t);
  }
  return t;
}

async function updateThreadContext(patch: Partial<AiAssistantThread>): Promise<AiAssistantThread> {
  const store = getAiAssistantDiskStore();
  const current = ensureThread();
  const next: AiAssistantThread = {
    ...current,
    ...patch,
    id: OWNER_THREAD_ID,
    ownerId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    updatedAt: Date.now(),
  };
  store.threads![OWNER_THREAD_ID] = next;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_threads', next.id, next);
  return next;
}

async function appendChatMessage(msg: Omit<AiAssistantMessage, 'id' | 'threadId' | 'ownerId' | 'ownerUsername'>): Promise<AiAssistantMessage> {
  const store = getAiAssistantDiskStore();
  const full: AiAssistantMessage = {
    id: makeId('aimsg'),
    threadId: OWNER_THREAD_ID,
    ownerId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    role: msg.role,
    text: sanitizeNoBannedAiDisclaimer(msg.text),
    toolSteps: msg.toolSteps ?? null,
    draftId: msg.draftId ?? null,
    pendingActionId: msg.pendingActionId ?? null,
    navigation: msg.navigation ?? null,
    createdAccounts: msg.createdAccounts && msg.createdAccounts.length > 0 ? msg.createdAccounts : null,
    timestamp: msg.timestamp || Date.now(),
  };
  store.messages!.push(full);
  if (store.messages!.length > 200) {
    store.messages = store.messages!.slice(-200);
  }
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_messages', full.id, full);
  return full;
}

async function appendAuditLog(entry: Omit<AiAssistantAuditLog, 'id' | 'ownerId' | 'ownerUsername' | 'timestamp'>): Promise<AiAssistantAuditLog> {
  const store = getAiAssistantDiskStore();
  const log: AiAssistantAuditLog = {
    id: makeId('aiaudit'),
    ownerId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    actionType: entry.actionType.slice(0, 64),
    command: String(entry.command || '').slice(0, 1000),
    target: String(entry.target || '').slice(0, 300),
    status: entry.status,
    details: sanitizeNoBannedAiDisclaimer(String(entry.details || '')).slice(0, 2000),
    timestamp: Date.now(),
  };
  store.auditLogs!.unshift(log);
  if (store.auditLogs!.length > 200) {
    store.auditLogs = store.auditLogs!.slice(0, 200);
  }
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_audit_logs', log.id, log);
  return log;
}

async function resolveChannelTarget(channelQueryOrId?: string | null, fallbackThread?: AiAssistantThread): Promise<ChannelRecord | null> {
  const channels = await getChannelsForUser(OWNER_ID, 'owner');
  if (channels.length === 0) return null;

  const q = String(channelQueryOrId || '').trim();
  if (!q) {
    if (fallbackThread?.activeChannelId) {
      const fromCtx = channels.find((c) => c.id === fallbackThread.activeChannelId);
      if (fromCtx) return fromCtx;
    }
    return null;
  }

  const exactId = channels.find((c) => c.id === q);
  if (exactId) return exactId;

  const normQ = normalizeArabicForMatch(q);
  const strippedNormQ = normQ.replace(/^(?:قناه|غرفه|روم)\s+/, '').trim();
  const candidatesQ = strippedNormQ && strippedNormQ !== normQ ? [normQ, strippedNormQ] : [normQ];

  for (const cand of candidatesQ) {
    const isGeneralAlias =
      cand.includes('القناه العامه') ||
      cand.includes('الدردشه العامه') ||
      cand === 'العامه' ||
      cand === 'عامه' ||
      cand === 'general';

    if (isGeneralAlias) {
      const openPub =
        channels.find((c) => c.id === 'general_trading') ||
        channels.find((c) => c.visibility === 'public' || c.isOpenPublic) ||
        channels.find((c) => normalizeArabicForMatch(c.name).includes('عامه'));
      if (openPub) return openPub;
    }

    const exactName = channels.find((c) => normalizeArabicForMatch(c.name) === cand);
    if (exactName) return exactName;
  }

  for (const cand of candidatesQ) {
    const partial = channels.find(
      (c) =>
        normalizeArabicForMatch(c.name).includes(cand) ||
        (normalizeArabicForMatch(c.name).length >= 2 && cand.includes(normalizeArabicForMatch(c.name)))
    );
    if (partial) return partial;
  }

  return null;
}

async function resolveUserTarget(userQueryOrId: string | number): Promise<{ id: number; username: string; displayName: string; role: string } | null> {
  const raw = String(userQueryOrId || '').trim();
  if (!raw) return null;
  const users = await getAllUsersList();
  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    const byId = users.find((u) => Number(u.id) === num);
    if (byId) return byId;
  }
  const clean = raw.replace(/^@/, '');
  const norm = normalizeArabicForMatch(clean);
  const exact = users.find(
    (u) =>
      normalizeArabicForMatch(u.username) === norm ||
      normalizeArabicForMatch(u.displayName) === norm
  );
  if (exact) return exact;

  const partial = users.find(
    (u) =>
      normalizeArabicForMatch(u.username).includes(norm) ||
      normalizeArabicForMatch(u.displayName).includes(norm)
  );
  return partial || null;
}

export interface SelectedAccountForDraft {
  id: number;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
}

async function generateDiverseVirtualPersonasWithEngine(params: {
  topic: string;
  count: number;
  channelName: string;
  recentMessagesSample: string[];
  selectedAccounts?: SelectedAccountForDraft[];
}): Promise<{ items: VirtualPersonaDraftItem[]; engineUsed: 'gemini' | 'internal' }> {
  const fixedAccounts =
    Array.isArray(params.selectedAccounts) && params.selectedAccounts.length > 0
      ? params.selectedAccounts
      : null;
  const safeCount = fixedAccounts
    ? fixedAccounts.length
    : Math.max(1, Math.min(30, Math.floor(Number(params.count) || 3)));
  const users = await getAllUsersList();
  const realNamesSet = new Set<string>();
  for (const u of users) {
    if (u.username) realNamesSet.add(normalizeArabicForMatch(u.username));
    if (u.displayName) realNamesSet.add(normalizeArabicForMatch(u.displayName));
  }

  if (isGeminiAvailableNow()) {
    const sampleBlock =
      params.recentMessagesSample.length > 0
        ? `\nأمثلة من آخر رسائل القناة للانسجام مع السياق (لا تنسخها):\n- ${params.recentMessagesSample.slice(-8).join('\n- ')}`
        : '';

    const fixedNamesBlock = fixedAccounts
      ? `\nالأسماء الحقيقية المعتمدة للمشاركين (${fixedAccounts.length} أعضاء — التزم بها بالترتيب وبدون تغيير):\n${fixedAccounts
          .map((a, idx) => `${idx + 1}. ${a.displayName}`)
          .join('\n')}`
      : `\nيُمنع تماماً استخدام أي اسم متكرر، ويُمنع استخدام الأسماء الحقيقية التالية الموجودة في التطبيق: ${Array.from(realNamesSet).slice(0, 60).join('، ') || 'لا يوجد'}.`;

    const prompt = `
أنت محرك توليد تفاعلات وحوارات واقعية ومتنوعة لأعضاء يمنيين في مجتمع تداول يديره القائد «سليم» (Salim).
المطلوب: إعداد بالضبط ${safeCount} رسالة/تفاعل مختلفة موجهة للقناة «${params.channelName}» حول الموضوع التالي:
"${params.topic}"
${sampleBlock}
${fixedNamesBlock}

شروط صارمة للتنوع والأصالة اليمنية والحوار الطبيعي (لا تخالف أياً منها):
1. الأسماء: ${fixedAccounts ? 'استخدم الأسماء المعتمدة المذكورة أعلاه بالضبط لكل رسالة بالترتيب.' : `اختر ${safeCount} أسماء يمنية واقعية ومتنوعة (ذكوراً وإناثاً).`}
2. تنوع اللهجات والأساليب اليمنية: اجعل جميع المشاركين يتحدثون باللهجة اليمنية الأصيلة ووزّع الرسائل بين اللهجات والأساليب اليمنية المتنوعة:
   - صنعاني (مثل: حيّا الله القائد، ما شاء الله تبارك الله، الله يفتح عليك، سلمت يمناك، شغلك مرتب)
   - عدني (مثل: يا سلام عليك، والله شغل فنان، ربنا يوفقنا جميعاً، تسلم يا غالي، تمام التمام)
   - تعزي / إبّي (مثل: ما شاء الله تبارك الرحمن، كفو يا سليم، الله يزيدك من فضله، خطوة قوية ومرتبة)
   - حضرمي / شبواني / يافعي (مثل: بارك الله فيك، الله يرزقنا وإياكم الخير، طرح طيب ومبارك)
   - فصحى طبيعية خفيفة بروح يمنية ودعاء صادق
   يُمنع استخدام لهجات غير يمنية (لا تستخدم مصري أو شامي أو عراقي أو خليجي مصطنع).
3. الترابط والحوار الحي بين الأعضاء: عندما يكون العدد 2 فأكثر، اجعل الرسائل تبدو كنقاش وتفاعل طبيعي مترابط داخل القناة وليس جملاً منفصلة مكررة؛ بحيث يتفاعل الأوائل مع الموضوع، ويتجاوب التاليون معه أو يبنون على كلام من قبلهم بعفوية.
4. تفاوت الطول والتركيب: اجعل بعض الرسائل قصيرة جداً (3-6 كلمات) وبعضها متوسطة (7-14 كلمة) وبعضها بجملتين قصيرتين (15-24 كلمة). نوّع في علامات الترقيم والإيموجي.
5. منع النسخ والتكرار والعبارات الجاهزة: ممنوع تكرار نفس العبارة الافتتاحية أو الخاتمة عبر أكثر من رسالة.
6. يُمنع تماماً كتابة أي عبارة تشير إلى الذكاء الاصطناعي أو التوليد الآلي مثل "مولّد بالذكاء الاصطناعي" أو أي وسوم نظامية.
7. التزم بتفاصيل الموضوع "${params.topic}" بصدق دون اختلاق أرقام لم ترد فيه.
8. تنفيذ الطلبات والأفعال المباشرة: إذا كان الموضوع يصف طلباً أو سؤالاً أو شكراً يوجّهه الأعضاء (مثل: "يطلبو من سليم يرسل صفقات" أو "تتطلب من سليم كذا" أو "يسألو عن كذا" أو "يشكرو سليم")، اكتب رسائلهم كتنفيذ مباشر وحقيقي لهذا الطلب أو السؤال بصيغ يمنية عفوية ومتنوعة (مثلاً: "نحتاج صفقات لو سمحت يا سليم"، "أرسلنا صفقات اليوم يا قايد"، "بالله شوف لنا صفقات جديدة يا أبو سليم"...) ولا تتحدث عن الطلب بصفة الغائب أو كموضوع نظري.
`;

    try {
      const response = await invokeGeminiGenerate({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                personaName: { type: Type.STRING, description: 'الاسم الظاهر للعضو اليمني' },
                dialect: { type: Type.STRING, description: 'اللهجة اليمنية مثل: صنعاني، عدني، تعزي، حضرمي، إبّي، يافعي، فصحى يمنية' },
                styleTag: { type: Type.STRING, description: 'وصف قصير لطول ونبرة الرسالة' },
                text: { type: Type.STRING, description: 'نص رسالة التفاعل باللهجة اليمنية' },
              },
              required: ['personaName', 'dialect', 'styleTag', 'text'],
            },
          },
        },
      });

      const rawText = String(response?.text || '[]').trim();
      const parsed = JSON.parse(rawText);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const usedNames = new Set<string>(realNamesSet);
        const usedTexts = new Set<string>();
        const fallbackSuffixes = [
          'الحميري',
          'اليافعي',
          'الأغبري',
          'المقطري',
          'السقاف',
          'العولقي',
          'الإرياني',
          'الشرجبي',
          'الذماري',
          'الصنعاني',
          'العدني',
          'الحضرمي',
        ];

        const items: VirtualPersonaDraftItem[] = [];
        for (let i = 0; i < parsed.length && items.length < safeCount; i++) {
          const row = parsed[i] || {};
          const boundAccount = fixedAccounts ? fixedAccounts[items.length] : undefined;
          let name = boundAccount
            ? boundAccount.displayName
            : sanitizeNoBannedAiDisclaimer(String(row.personaName || `متابع يمني ${i + 1}`)).slice(0, 48).trim();
          if (!name) name = `متداول يمني ${i + 1}`;

          if (!boundAccount) {
            let normName = normalizeArabicForMatch(name);
            if (usedNames.has(normName)) {
              const suf = fallbackSuffixes[i % fallbackSuffixes.length];
              name = `${name} ${suf}`.slice(0, 48);
              normName = normalizeArabicForMatch(name);
              if (usedNames.has(normName)) {
                name = `${name} ${i + 11}`;
                normName = normalizeArabicForMatch(name);
              }
            }
            usedNames.add(normName);
          }

          const text = sanitizeNoBannedAiDisclaimer(String(row.text || '')).slice(0, 500).trim();
          const normText = normalizeArabicForMatch(text);
          if (!text || usedTexts.has(normText)) continue;
          usedTexts.add(normText);

          items.push({
            id: `vp_${items.length + 1}_${crypto.randomBytes(3).toString('hex')}`,
            ...(boundAccount
              ? {
                  userId: boundAccount.id,
                  username: boundAccount.username,
                  avatarUrl: boundAccount.avatarUrl || null,
                }
              : {}),
            personaName: name,
            dialect: String(row.dialect || 'يمني').slice(0, 40),
            styleTag: String(row.styleTag || 'متنوع').slice(0, 60),
            text,
          });
        }

        if (items.length > 0) {
          if (items.length < safeCount) {
            const remainingFixed = fixedAccounts
              ? fixedAccounts.slice(items.length).map((a) => ({ name: a.displayName }))
              : undefined;
            const topUp = generateInternalYemeniPersonas({
              topic: params.topic,
              count: safeCount - items.length,
              channelName: params.channelName,
              recentMessagesSample: [...params.recentMessagesSample, ...items.map((x) => x.text)],
              realNamesNormSet: usedNames,
              fixedPersonas: remainingFixed,
            });
            topUp.forEach((tp, idx) => {
              const bound = fixedAccounts ? fixedAccounts[items.length + idx] : undefined;
              items.push({
                ...tp,
                ...(bound
                  ? {
                      userId: bound.id,
                      username: bound.username,
                      avatarUrl: bound.avatarUrl || null,
                      personaName: bound.displayName,
                    }
                  : {}),
              });
            });
          }
          return { items: items.slice(0, safeCount), engineUsed: 'gemini' };
        }
      }
      tripGeminiFallback('مخرجات النموذج غير مكتملة.');
    } catch {
      // Fall through cleanly to the internal Yemeni engine without interrupting the user
    }
  }

  const internalItems = generateInternalYemeniPersonas({
    topic: params.topic,
    count: safeCount,
    channelName: params.channelName,
    recentMessagesSample: params.recentMessagesSample,
    realNamesNormSet: realNamesSet,
    fixedPersonas: fixedAccounts ? fixedAccounts.map((a) => ({ name: a.displayName })) : undefined,
  }).map((it, idx) => {
    const bound = fixedAccounts ? fixedAccounts[idx] : undefined;
    return bound
      ? {
          ...it,
          userId: bound.id,
          username: bound.username,
          avatarUrl: bound.avatarUrl || null,
          personaName: bound.displayName,
        }
      : it;
  });
  return { items: internalItems, engineUsed: 'internal' };
}

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'list_channels',
    description: 'استعراض جميع القنوات المتاحة في تطبيق Salim مع معرفاتها وحالتها وعدد أعضائها.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'navigate_app',
    description: 'الانتقال إلى قسم معين في التطبيق أو فتح قناة محددة أو محادثة خاصة وتحديث السياق النشط للمساعد.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        section: {
          type: Type.STRING,
          description: 'القسم المستهدف: dashboard | channels | private_chat | admin | history | roadmap | settings | ai_assistant',
        },
        channelQuery: {
          type: Type.STRING,
          description: 'اسم القناة أو معرفها عند التوجه لقناة محددة (مثل: القناة العامة).',
        },
        partnerQuery: {
          type: Type.STRING,
          description: 'اسم المستخدم أو معرفه عند التوجه لمحادثة خاصة.',
        },
      },
      required: ['section'],
    },
  },
  {
    name: 'read_channel_messages',
    description: 'قراءة آخر الرسائل داخل قناة محددة (أو القناة النشطة في السياق الحالي).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        channelQuery: {
          type: Type.STRING,
          description: 'اسم القناة أو معرفها. يُترك فارغاً لاستخدام القناة النشطة حالياً.',
        },
        limit: {
          type: Type.NUMBER,
          description: 'عدد الرسائل المطلوب قراءتها (بين 1 و 50).',
        },
      },
    },
  },
  {
    name: 'list_users',
    description: 'عرض قائمة المستخدمين المسجلين في التطبيق مع أدوارهم ومعرفاتهم.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        search: {
          type: Type.STRING,
          description: 'نص اختياري للبحث باسم المستخدم أو الاسم الظاهر.',
        },
      },
    },
  },
  {
    name: 'read_user_challenge_and_trades',
    description: 'الاطلاع على بيانات تحدي الـ 150 محطة وآخر الصفقات لمستخدم معين.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        userQuery: {
          type: Type.STRING,
          description: 'اسم المستخدم أو معرفه (افتراضياً 1 للمالك).',
        },
      },
    },
  },
  {
    name: 'prepare_virtual_persona_interactions',
    description:
      'بدء إعداد تفاعلات أو حوار بين عدة مشاركين حول موضوع محدد في قناة معينة: يعرض للمالك خيارين (إنشاء حسابات جديدة أو اختيار من الحسابات الحالية) قبل توليد النصوص باللهجة اليمنية، أو ينفذ التوليد مباشرة إذا حدد المالك الخيار صراحة.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        channelQuery: {
          type: Type.STRING,
          description: 'القناة المستهدفة (اسمها أو معرفها، أو القناة العامة/النشطة إن تُركت فارغة).',
        },
        count: {
          type: Type.NUMBER,
          description: 'عدد المشاركين والتفاعلات المطلوب إعدادها (بين 1 و 30).',
        },
        topic: {
          type: Type.STRING,
          description: 'الموضوع أو الطلب الذي ستتحدث عنه أو تطلبه الشخصيات حرفياً (مثل: "يطلبون من سليم إرسال صفقات" أو "إدارة رأس المال").',
        },
        intervalSeconds: {
          type: Type.NUMBER,
          description: 'الفاصل الزمني بالثواني بين كل رسالة وأخرى عند النشر (مثلاً 30 أو 60، أو 0 للإرسال الفوري).',
        },
        accountMode: {
          type: Type.STRING,
          description: 'ask (الافتراضي: لعرض الخيارين للمالك) أو create_new أو select_existing إذا حدده المالك صراحة.',
        },
      },
      required: ['count', 'topic'],
    },
  },
  {
    name: 'resolve_interaction_accounts',
    description:
      'تنفيذ اختيار المالك لطلب التفاعلات المعلق: إما إنشاء حسابات جديدة (create_new) أو اختيار من الحسابات الحالية (select_existing)، ثم توليد المواضيع والرسائل باللهجة اليمنية بأسمائهم.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        mode: {
          type: Type.STRING,
          description: 'create_new لإنشاء حسابات جديدة، أو select_existing لاختيار حسابات حالية.',
        },
        selectedUserIds: {
          type: Type.ARRAY,
          items: { type: Type.NUMBER },
          description: 'معرفات الحسابات الحالية المختارة عند mode=select_existing (اختياري).',
        },
      },
      required: ['mode'],
    },
  },
  {
    name: 'confirm_pending',
    description:
      'تنفيذ أو إلغاء مسودة التفاعلات المعلقة أو الإجراء الإداري المعلق بعد موافقة المالك الصريحة في رسالته الحالية.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        decision: {
          type: Type.STRING,
          description: 'approve لتنفيذ ونشر المعلق، أو cancel لإلغائه.',
        },
        targetId: {
          type: Type.STRING,
          description: 'معرف المسودة أو الإجراء المعلق (اختياري، يختار الأحدث إذا تُرك فارغاً).',
        },
        intervalSeconds: {
          type: Type.NUMBER,
          description: 'فاصل زمني بالثواني بين كل رسالة شخصية وأخرى إذا حدّده المالك عند الموافقة (مثلاً 30 ثانية).',
        },
      },
      required: ['decision'],
    },
  },
  {
    name: 'propose_channel_message',
    description: 'تجهيز إرسال رسالة رسمية باسم القائد Salim في قناة محددة بانتظار تأكيد المالك.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        channelQuery: { type: Type.STRING, description: 'اسم القناة أو معرفها.' },
        text: { type: Type.STRING, description: 'نص الرسالة المطلوب إرسالها.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'propose_private_message',
    description: 'تجهيز إرسال رسالة خاصة من حساب المالك Salim إلى مستخدم محدد بانتظار التأكيد.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        userQuery: { type: Type.STRING, description: 'اسم المستخدم أو معرفه.' },
        text: { type: Type.STRING, description: 'نص الرسالة الخاصة.' },
      },
      required: ['userQuery', 'text'],
    },
  },
  {
    name: 'propose_create_channel',
    description: 'تجهيز إنشاء قناة جديدة في التطبيق بانتظار تأكيد المالك.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: 'اسم القناة.' },
        description: { type: Type.STRING, description: 'وصف القناة.' },
        isOpenPublic: { type: Type.BOOLEAN, description: 'هل القناة مفتوحة للجميع؟' },
        visibility: { type: Type.STRING, description: 'visible أو hidden' },
        password: { type: Type.STRING, description: 'كلمة مرور القناة إن كانت مغلقة.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'propose_update_channel',
    description: 'تجهيز تعديل إعدادات قناة قائمة (الاسم، الوصف، كلمة المرور، الخصوصية) بانتظار التأكيد.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        channelQuery: { type: Type.STRING, description: 'اسم أو معرف القناة الحالية.' },
        name: { type: Type.STRING, description: 'الاسم الجديد (اختياري).' },
        description: { type: Type.STRING, description: 'الوصف الجديد (اختياري).' },
        isOpenPublic: { type: Type.BOOLEAN, description: 'تغيير الفتح للعامة (اختياري).' },
        visibility: { type: Type.STRING, description: 'visible أو hidden (اختياري).' },
        password: { type: Type.STRING, description: 'كلمة المرور الجديدة (اختياري).' },
      },
      required: ['channelQuery'],
    },
  },
  {
    name: 'propose_delete_channel',
    description: 'تجهيز حذف قناة بالكامل (إجراء حساس يتطلب تأكيد المالك الصريح).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        channelQuery: { type: Type.STRING, description: 'اسم القناة أو معرفها المطلوب حذفها.' },
      },
      required: ['channelQuery'],
    },
  },
  {
    name: 'propose_manage_channel_members',
    description: 'تجهيز إضافة عضو إلى قناة أو إزالته منها بانتظار تأكيد المالك.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        operation: { type: Type.STRING, description: 'add أو remove' },
        channelQuery: { type: Type.STRING, description: 'اسم القناة أو معرفها.' },
        userQuery: { type: Type.STRING, description: 'اسم المستخدم أو معرفه.' },
      },
      required: ['operation', 'channelQuery', 'userQuery'],
    },
  },
  {
    name: 'propose_manage_user',
    description: 'تجهيز ترقية/تخفيض رتبة مستخدم (user/moderator) أو حذف حسابه بانتظار تأكيد المالك.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        operation: { type: Type.STRING, description: 'set_role أو delete_user' },
        userQuery: { type: Type.STRING, description: 'اسم المستخدم أو معرفه.' },
        role: { type: Type.STRING, description: 'عند set_role: moderator أو user' },
      },
      required: ['operation', 'userQuery'],
    },
  },
  {
    name: 'propose_pin_channel_message',
    description: 'تجهيز تثبيت أو إلغاء تثبيت رسالة داخل قناة بانتظار تأكيد المالك.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        channelQuery: { type: Type.STRING, description: 'اسم أو معرف القناة.' },
        messageId: { type: Type.STRING, description: 'معرف الرسالة.' },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'create_user_accounts',
    description:
      'إنشاء حساب مستخدم واحد أو عدة حسابات فعلية في نظام المستخدمين الحالي بصلاحية عضو عادي (role: user) مع توليد أسماء يمنية متنوعة وأسماء مستخدمين إنجليزية فريدة وكلمات مرور عشوائية قوية وعرض بيانات الدخول للمالك.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        count: {
          type: Type.NUMBER,
          description: 'عدد الحسابات المطلوب إنشاؤها (من 1 إلى 30).',
        },
        customDisplayNames: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'أسماء عرض مخصصة (اختياري؛ إذا تُركت فارغة يتم توليد أسماء يمنية متنوعة تلقائياً).',
        },
        customPassword: {
          type: Type.STRING,
          description: 'كلمة مرور محددة عند إنشاء حساب واحد فقط (اختياري).',
        },
      },
      required: ['count'],
    },
  },
  {
    name: 'update_user_account',
    description:
      'تعديل بيانات مستخدم عادي في النظام مباشرة (الاسم الظاهر، كلمة المرور، إعادة تعيين كلمة مرور عشوائية، أو عدد الإنذارات) دون المساس بحساب المالك.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        userQuery: { type: Type.STRING, description: 'اسم المستخدم أو المعرف أو الاسم الظاهر.' },
        displayName: { type: Type.STRING, description: 'الاسم الظاهر الجديد (اختياري).' },
        password: { type: Type.STRING, description: 'كلمة المرور الجديدة (اختياري).' },
        generateRandomPassword: { type: Type.BOOLEAN, description: 'إن true يولّد كلمة مرور عشوائية قوية جديدة.' },
        warningsCount: { type: Type.NUMBER, description: 'عدد الإنذارات الجديد (اختياري).' },
      },
      required: ['userQuery'],
    },
  },
  {
    name: 'delete_user_account',
    description: 'حذف حساب مستخدم عادي (غير المالك) من النظام مباشرة.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        userQuery: { type: Type.STRING, description: 'اسم المستخدم الدقيق أو المعرف الرقمي.' },
      },
      required: ['userQuery'],
    },
  },
  {
    name: 'get_audit_logs',
    description: 'جلب آخر سجلات التدقيق لعمليات المساعد الذكي.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.NUMBER, description: 'عدد السجلات المطلوبة (حتى 30).' },
      },
    },
  },
];

function buildSystemInstruction(thread: AiAssistantThread, openDraft: AiAssistantDraft | null, openAction: AiAssistantPendingAction | null): string {
  const ctxSummary = [
    `القسم النشط: ${thread.activeSection || 'ai_assistant'}`,
    `القناة النشطة حالياً: ${thread.activeChannelName ? `${thread.activeChannelName} (${thread.activeChannelId})` : 'غير محددة'}`,
    `الشريك النشط بالخاص: ${thread.activePartnerId || 'غير محدد'}`,
    openDraft
      ? `توجد مسودة تفاعلات معلقة بانتظار الاعتماد: id=${openDraft.id} في قناة "${openDraft.channelName}" (${openDraft.items.length} تفاعلات حول "${openDraft.topic}"، الفاصل المبدئي: ${openDraft.intervalSeconds || 0} ثانية).`
      : 'لا توجد مسودة تفاعلات معلقة حالياً.',
    openAction
      ? `يوجد إجراء حساس معلق بانتظار التأكيد: id=${openAction.id} (${openAction.titleAr} — ${openAction.summaryAr}).`
      : 'لا يوجد إجراء إداري معلق حالياً.',
  ].join('\n');

  return `أنت «المساعد الذكي» التنفيذي والإداري الحصري لحساب المالك الرئيسي "سليم" (Salim) داخل تطبيق Salim لتحديات التداول وإدارة القنوات.

قواعد السلوك والتنفيذ:
1. خاطب المالك سليم مباشرة بالعربية الطبيعية الواضحة والمهذبة والعملية، وافهم اللهجات والطلبات غير الرسمية.
2. نفّذ المهام فعلياً باستخدام الأدوات المتاحة بدلاً من مجرد شرح الطريقة للمستخدم. بعد تنفيذ أي أداة، اعرض بوضوح ودقة النتيجة الفعلية التي تمت.
3. إنشاء وإدارة حسابات المستخدمين في النظام الحالي:
   - عند طلب إنشاء حساب مستخدم أو عدة حسابات، استدعِ الأداة create_user_accounts فوراً (تُنشأ جميع الحسابات بصلاحية عضو عادي user فقط وبأسماء يمنية متنوعة وأسماء مستخدمين إنجليزية فريدة وكلمات مرور عشوائية قوية).
   - اعرض للمالك تفاصيل الحسابات وبيانات الدخول التي أرجعتها الأداة بوضوح.
   - عند طلب تعديل بيانات مستخدم عادي أو حذف حساب غير محمي، يمكنك استخدام update_user_account أو delete_user_account مباشرة.
4. التزم بالسياق النشط: إذا انتقل المالك لقناة أو قسم في رسالة سابقة ثم قال في رسالة لاحقة "أنشئ تفاعلات" أو "اقرأ الرسائل"، استخدم القناة النشطة في السياق.
5. التفاعلات والحوارات باللهجة اليمنية (الاختيار المسبق للحسابات والمراجعة):
   - عندما يطلب المالك عدداً من الشخصيات أو الأعضاء للتحدث عن موضوع في قناة (مثل: "أريد 10 شخصيات يتكلموا عن موضوع ... في قناة ..."): استدعِ الأداة prepare_virtual_persona_interactions مع accountMode='ask' لعرض خيارين واضحين للمالك أولاً: (1) إنشاء حسابات جديدة، أو (2) اختيار من الحسابات الحالية.
   - عندما يرد المالك باختيار أحد الخيارين ("إنشاء حسابات جديدة" أو "اختيار من الحسابات الحالية")، استدعِ الأداة resolve_interaction_accounts فوراً لتجهيز الحسابات ثم توليد الرسائل باللهجة اليمنية وعرضها في مسودة للمراجعة والاعتماد.
   - إذا حدد المالك وقتاً أو فاصلاً زمنياً بين كل رسالة وأخرى (مثل: "كل 30 ثانية" أو "كل دقيقة")، مرّر قيمة intervalSeconds بالثواني.
   - لا تنشر التفاعلات تلقائياً قبل مراجعة المالك وموافقته.
   - لا تُضف وسم "شخصية افتراضية" بجانب أسماء الأعضاء أو الرسائل المنشورة، واحرص على إظهارها بأسمائها اليمنية الطبيعية كحسابات أعضاء حقيقيين.
   - يُمنع منعاً باتاً كتابة عبارة "مولّد بالذكاء الاصطناعي" أو ترديدها.
6. الإجراءات الإدارية للقنوات والرسائل الحساسة (إرسال رسالة قناة/خاصة، إنشاء/تعديل/حذف قناة، إضافة/إزالة عضو، تغيير رتبة مشرف، تثبيت رسالة):
   - استخدم أداة propose_* المناسبة لتجهيز الإجراء وعرض ملخصه الواضح للمالك بانتظار تأكيده الصريح.
   - عندما يرد المالك في رسالة لاحقة بالموافقة الصريحة (مثل: "انشرها"، "اعتمد"، "نعم نفذ"، "موافق") أو الإلغاء، استدعِ confirm_pending.
7. كن أميناً ودقيقاً: لا تخترع رسائل أو أسماء أو أرقام غير موجودة في نتائج الأدوات، وإذا تعذر تنفيذ شيء اذكر السبب الفعلي مباشرة.

السياق الحالي:
${ctxSummary}`;
}

export async function getAiAssistantState(): Promise<{
  thread: AiAssistantThread;
  messages: AiAssistantMessage[];
  drafts: AiAssistantDraft[];
  pendingActions: AiAssistantPendingAction[];
  auditLogs: AiAssistantAuditLog[];
}> {
  const store = getAiAssistantDiskStore();
  const thread = ensureThread();
  const messages = [...(store.messages || [])].sort((a, b) => a.timestamp - b.timestamp).slice(-80);
  const drafts = Object.values(store.drafts || {})
    .sort((a: any, b: any) => b.createdAt - a.createdAt)
    .slice(0, 15) as AiAssistantDraft[];
  const pendingActions = Object.values(store.pendingActions || {})
    .sort((a: any, b: any) => b.createdAt - a.createdAt)
    .slice(0, 20) as AiAssistantPendingAction[];
  const auditLogs = [...(store.auditLogs || [])]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 50) as AiAssistantAuditLog[];

  return { thread, messages, drafts, pendingActions, auditLogs };
}

function buildVirtualPersonaChannelMessage(
  draft: AiAssistantDraft,
  channelId: string,
  item: VirtualPersonaDraftItem,
  index: number,
  timestamp: number
): ChannelMessage {
  const hashNum = crypto.createHash('md5').update(`${draft.id}:${item.id}:${index}`).digest().readUInt16BE(0);
  const realUserId = Number(item.userId);
  const senderId =
    Number.isFinite(realUserId) && realUserId > 0 && realUserId < 9000000
      ? realUserId
      : 10000 + (hashNum % 89999);
  return {
    id: `msg_${timestamp}_${index}_${crypto.randomBytes(3).toString('hex')}`,
    channelId,
    senderId,
    senderName: item.personaName,
    senderRole: 'user',
    senderAvatarUrl: item.avatarUrl || null,
    text: sanitizeNoBannedAiDisclaimer(item.text),
    reactions: {},
    isPinned: false,
    isDeleted: false,
    createdByOwnerId: OWNER_ID,
    timestamp,
  };
}

function clearDraftTimer(draftId: string): void {
  const existing = activeDraftTimers.get(draftId);
  if (existing) {
    clearTimeout(existing);
    activeDraftTimers.delete(draftId);
  }
}

async function publishNextScheduledDraftItem(draftId: string): Promise<void> {
  activeDraftTimers.delete(draftId);
  const store = getAiAssistantDiskStore();
  const draft = store.drafts?.[draftId] as AiAssistantDraft | undefined;
  if (!draft || draft.status !== 'publishing') return;

  const idx = Math.max(0, Number(draft.publishedCount || 0));
  if (idx >= draft.items.length) {
    const completed: AiAssistantDraft = {
      ...draft,
      status: 'published',
      nextPublishAt: null,
      updatedAt: Date.now(),
    };
    store.drafts![draft.id] = completed;
    saveAiAssistantDiskStore();
    await tryWriteFirestoreDoc('ai_assistant_drafts', completed.id, completed);
    return;
  }

  const channel = await getChannelById(draft.channelId);
  if (!channel) {
    const failed: AiAssistantDraft = {
      ...draft,
      status: 'cancelled',
      nextPublishAt: null,
      updatedAt: Date.now(),
    };
    store.drafts![draft.id] = failed;
    saveAiAssistantDiskStore();
    await tryWriteFirestoreDoc('ai_assistant_drafts', failed.id, failed);
    await appendAuditLog({
      actionType: 'publish_virtual_personas',
      command: 'نشر مجدول للتفاعلات',
      target: `${draft.channelName} (${draft.channelId})`,
      status: 'error',
      details: 'تم إيقاف النشر المجدول لأن القناة المستهدفة لم تعد موجودة.',
    });
    return;
  }

  const now = Date.now();
  const item = draft.items[idx];
  const msg = buildVirtualPersonaChannelMessage(draft, channel.id, item, idx, now);
  await saveChannelMessage(msg);

  dispatchAuthorizedChatPush({
    senderId: msg.senderId,
    senderName: msg.senderName,
    senderRole: 'user',
    title: `💬 ${channel.name}`,
    chatType: 'channel',
    channelId: channel.id,
    messageId: msg.id,
    snippet: msg.text || 'تفاعل جديد في القناة',
  }).catch(() => {});

  const nextPublishedCount = idx + 1;
  const intervalSec = clampIntervalSeconds(draft.intervalSeconds);
  const isDone = nextPublishedCount >= draft.items.length;

  const updated: AiAssistantDraft = {
    ...draft,
    status: isDone ? 'published' : 'publishing',
    publishedCount: nextPublishedCount,
    nextPublishAt: isDone ? null : Date.now() + Math.max(1, intervalSec) * 1000,
    updatedAt: Date.now(),
  };
  store.drafts![draft.id] = updated;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_drafts', updated.id, updated);

  if (isDone) {
    await appendAuditLog({
      actionType: 'publish_virtual_personas',
      command: 'إتمام النشر المجدول',
      target: `${channel.name} (${channel.id})`,
      status: 'success',
      details: `تم إتمام نشر جميع التفاعلات المجدولة (${nextPublishedCount}/${draft.items.length}) بفاصل ${intervalSec} ثانية حول: ${draft.topic}`,
    });
  } else {
    scheduleDraftTimer(draft.id);
  }
}

function scheduleDraftTimer(draftId: string): void {
  clearDraftTimer(draftId);
  const store = getAiAssistantDiskStore();
  const draft = store.drafts?.[draftId] as AiAssistantDraft | undefined;
  if (!draft || draft.status !== 'publishing') return;

  const nextAt = Number(draft.nextPublishAt || Date.now() + clampIntervalSeconds(draft.intervalSeconds) * 1000);
  const delayMs = Math.max(50, nextAt - Date.now());
  const timer = setTimeout(() => {
    void publishNextScheduledDraftItem(draftId).catch((err) => {
      console.warn('[Salim AI] Scheduled draft tick error:', err?.message || err);
    });
  }, delayMs);
  activeDraftTimers.set(draftId, timer);
}

// Resume any in-progress scheduled drafts cleanly after server restart
setTimeout(() => {
  try {
    const store = getAiAssistantDiskStore();
    for (const draft of Object.values(store.drafts || {}) as AiAssistantDraft[]) {
      if (draft?.id && draft.status === 'publishing') {
        scheduleDraftTimer(draft.id);
      }
    }
  } catch {}
}, 1500).unref?.();

export async function approveAndPublishDraft(
  draftId: string,
  commandContext = 'اعتماد ونشر مسودة التفاعلات',
  intervalSecondsOverride?: number
): Promise<{ draft: AiAssistantDraft; publishedMessages: ChannelMessage[]; scheduled: boolean }> {
  const store = getAiAssistantDiskStore();
  const draft = store.drafts?.[draftId] as AiAssistantDraft | undefined;
  if (!draft) {
    throw new Error('لم يتم العثور على مسودة التفاعلات المطلوبة.');
  }
  if (draft.status !== 'pending_approval') {
    if (draft.status === 'publishing') {
      throw new Error('هذه المسودة قيد النشر المجدول حالياً.');
    }
    throw new Error(draft.status === 'published' ? 'تم نشر هذه المسودة مسبقاً.' : 'تم إلغاء هذه المسودة.');
  }
  const channel = await getChannelById(draft.channelId);
  if (!channel) {
    throw new Error(`القناة المستهدفة (${draft.channelName}) غير موجودة.`);
  }

  const safeInterval = clampIntervalSeconds(
    intervalSecondsOverride !== undefined ? intervalSecondsOverride : draft.intervalSeconds
  );
  const baseTs = Date.now();
  const publishedMessages: ChannelMessage[] = [];

  if (safeInterval > 0 && draft.items.length > 1) {
    const firstItem = draft.items[0];
    const firstMsg = buildVirtualPersonaChannelMessage(draft, channel.id, firstItem, 0, baseTs);
    await saveChannelMessage(firstMsg);
    publishedMessages.push(firstMsg);

    const nextPublishAt = Date.now() + safeInterval * 1000;
    const updatedDraft: AiAssistantDraft = {
      ...draft,
      status: 'publishing',
      intervalSeconds: safeInterval,
      publishedCount: 1,
      nextPublishAt,
      updatedAt: Date.now(),
    };
    store.drafts![draft.id] = updatedDraft;
    saveAiAssistantDiskStore();
    await tryWriteFirestoreDoc('ai_assistant_drafts', updatedDraft.id, updatedDraft);

    await appendAuditLog({
      actionType: 'publish_virtual_personas',
      command: commandContext,
      target: `${channel.name} (${channel.id})`,
      status: 'pending',
      details: `بدأ النشر المجدول (1/${draft.items.length}) كل ${safeInterval} ثانية حول: ${draft.topic}`,
    });

    dispatchAuthorizedChatPush({
      senderId: firstMsg.senderId,
      senderName: firstMsg.senderName,
      senderRole: 'user',
      title: `💬 ${channel.name}`,
      chatType: 'channel',
      channelId: channel.id,
      messageId: firstMsg.id,
      snippet: firstMsg.text || 'تفاعل جديد في القناة',
    }).catch(() => {});

    scheduleDraftTimer(updatedDraft.id);
    return { draft: updatedDraft, publishedMessages, scheduled: true };
  }

  for (let i = 0; i < draft.items.length; i++) {
    const item = draft.items[i];
    const msg = buildVirtualPersonaChannelMessage(draft, channel.id, item, i, baseTs + i * 1000);
    await saveChannelMessage(msg);
    publishedMessages.push(msg);
  }

  const updatedDraft: AiAssistantDraft = {
    ...draft,
    status: 'published',
    intervalSeconds: 0,
    nextPublishAt: null,
    publishedCount: publishedMessages.length,
    updatedAt: Date.now(),
  };
  store.drafts![draft.id] = updatedDraft;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_drafts', updatedDraft.id, updatedDraft);

  await appendAuditLog({
    actionType: 'publish_virtual_personas',
    command: commandContext,
    target: `${channel.name} (${channel.id})`,
    status: 'success',
    details: `تم نشر ${publishedMessages.length} تفاعلات حول: ${draft.topic}`,
  });

  if (publishedMessages.length > 0) {
    const last = publishedMessages[publishedMessages.length - 1];
    dispatchAuthorizedChatPush({
      senderId: last.senderId,
      senderName: last.senderName,
      senderRole: 'user',
      title: `💬 ${channel.name}`,
      chatType: 'channel',
      channelId: channel.id,
      messageId: last.id,
      snippet: last.text || 'تفاعل جديد في القناة',
    }).catch(() => {});
  }

  return { draft: updatedDraft, publishedMessages, scheduled: false };
}

export async function updateDraftItems(
  draftId: string,
  items: VirtualPersonaDraftItem[],
  intervalSeconds?: number
): Promise<AiAssistantDraft> {
  const store = getAiAssistantDiskStore();
  const draft = store.drafts?.[draftId] as AiAssistantDraft | undefined;
  if (!draft) throw new Error('المسودة غير موجودة.');
  if (draft.status !== 'pending_approval') {
    throw new Error('لا يمكن تعديل مسودة منشورة أو قيد النشر أو ملغاة.');
  }
  const cleaned: VirtualPersonaDraftItem[] = (Array.isArray(items) ? items : [])
    .map((it, idx) => ({
      id: String(it.id || `vp_${idx + 1}`),
      ...(it.userId && Number(it.userId) > 0 ? { userId: Number(it.userId) } : {}),
      ...(it.username ? { username: String(it.username).slice(0, 60) } : {}),
      ...(it.avatarUrl !== undefined ? { avatarUrl: it.avatarUrl || null } : {}),
      personaName: sanitizeNoBannedAiDisclaimer(String(it.personaName || `عضو يمني ${idx + 1}`)).slice(0, 60),
      dialect: String(it.dialect || 'يمني').slice(0, 40),
      styleTag: String(it.styleTag || 'متنوع').slice(0, 60),
      text: sanitizeNoBannedAiDisclaimer(String(it.text || '')).slice(0, 500),
    }))
    .filter((it) => it.personaName && it.text);

  if (cleaned.length === 0) {
    throw new Error('يجب أن تحتوي المسودة على تفاعل واحد صالح على الأقل.');
  }

  const nextInterval =
    intervalSeconds !== undefined
      ? clampIntervalSeconds(intervalSeconds)
      : clampIntervalSeconds(draft.intervalSeconds);

  const next: AiAssistantDraft = {
    ...draft,
    items: cleaned,
    intervalSeconds: nextInterval,
    updatedAt: Date.now(),
  };
  store.drafts![draft.id] = next;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_drafts', next.id, next);
  return next;
}

export async function cancelDraft(draftId: string): Promise<AiAssistantDraft> {
  const store = getAiAssistantDiskStore();
  const draft = store.drafts?.[draftId] as AiAssistantDraft | undefined;
  if (!draft) throw new Error('المسودة غير موجودة.');
  if (draft.status !== 'pending_approval' && draft.status !== 'publishing') {
    throw new Error('هذه المسودة لم تعد معلقة أو قيد النشر.');
  }
  const wasPublishing = draft.status === 'publishing';
  clearDraftTimer(draftId);

  const next: AiAssistantDraft = {
    ...draft,
    status: 'cancelled',
    nextPublishAt: null,
    updatedAt: Date.now(),
  };
  store.drafts![draft.id] = next;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_drafts', next.id, next);

  await appendAuditLog({
    actionType: 'cancel_virtual_personas',
    command: wasPublishing ? 'إيقاف النشر المجدول' : 'إلغاء مسودة التفاعلات',
    target: `${draft.channelName} (${draft.channelId})`,
    status: 'cancelled',
    details: wasPublishing
      ? `تم إيقاف النشر المجدول بعد إرسال ${draft.publishedCount || 0} من أصل ${draft.items.length} تفاعلات.`
      : `تم إلغاء المسودة (${draft.items.length} تفاعلات) قبل النشر.`,
  });

  return next;
}

export async function confirmPendingAction(
  actionId: string,
  commandContext = 'تأكيد تنفيذ الإجراء الإداري'
): Promise<{ action: AiAssistantPendingAction; navigation?: AiNavigationDirective | null }> {
  const store = getAiAssistantDiskStore();
  const action = store.pendingActions?.[actionId] as AiAssistantPendingAction | undefined;
  if (!action) throw new Error('لم يتم العثور على الإجراء المعلق.');
  if (action.status !== 'pending') {
    throw new Error(action.status === 'executed' ? 'تم تنفيذ هذا الإجراء مسبقاً.' : 'تم إلغاء هذا الإجراء مسبقاً.');
  }

  const p = action.payload || {};
  let resultMessage = '';
  let navigation: AiNavigationDirective | null = null;
  let targetDesc = action.titleAr;

  try {
    if (action.actionType === 'send_channel_message') {
      const ch = await getChannelById(String(p.channelId));
      if (!ch) throw new Error('القناة لم تعد موجودة.');
      const owner = await getUserById(OWNER_ID);
      const now = Date.now();
      const msg: ChannelMessage = {
        id: makeId('msg'),
        channelId: ch.id,
        senderId: OWNER_ID,
        senderName: owner?.displayName || 'القائد Salim',
        senderRole: 'owner',
        senderAvatarUrl: owner?.avatarUrl || null,
        text: String(p.text || ''),
        reactions: {},
        isPinned: false,
        isDeleted: false,
        timestamp: now,
      };
      await saveChannelMessage(msg);
      dispatchAuthorizedChatPush({
        senderId: OWNER_ID,
        senderName: msg.senderName,
        senderRole: 'owner',
        title: `👑 ${msg.senderName} • ${ch.name}`,
        chatType: 'channel',
        channelId: ch.id,
        messageId: msg.id,
        snippet: msg.text || 'رسالة جديدة',
      }).catch(() => {});
      resultMessage = `تم إرسال الرسالة بنجاح في قناة «${ch.name}».`;
      targetDesc = `${ch.name} (${ch.id})`;
      navigation = { tab: 'channels', channelId: ch.id, channelName: ch.name, messageId: msg.id };
    } else if (action.actionType === 'send_private_message') {
      const targetUser = await getUserById(Number(p.receiverId));
      if (!targetUser) throw new Error('المستخدم المستلم غير موجود.');
      const owner = await getUserById(OWNER_ID);
      const now = Date.now();
      const id = makeId('pm');
      const convId = [OWNER_ID, targetUser.id].sort((a, b) => a - b).join('_');
      await savePrivateMessageRecord({
        id,
        conversationId: convId,
        senderId: OWNER_ID,
        receiverId: targetUser.id,
        senderName: owner?.displayName || 'القائد Salim',
        senderRole: 'owner',
        senderAvatarUrl: owner?.avatarUrl || null,
        text: String(p.text || ''),
        timestamp: now,
        isPinned: false,
        reactions: {},
      });
      dispatchAuthorizedChatPush({
        senderId: OWNER_ID,
        senderName: owner?.displayName || 'القائد Salim',
        senderRole: 'owner',
        title: `👑 رسالة خاصة من القائد Salim`,
        chatType: 'private',
        receiverId: targetUser.id,
        partnerId: OWNER_ID,
        targetUserIds: [targetUser.id],
        messageId: id,
        snippet: String(p.text || ''),
      }).catch(() => {});
      resultMessage = `تم إرسال الرسالة الخاصة إلى ${targetUser.displayName} (@${targetUser.username}) بنجاح.`;
      targetDesc = `${targetUser.username} (#${targetUser.id})`;
      navigation = { tab: 'private_chat', partnerId: targetUser.id, partnerName: targetUser.displayName, messageId: id };
    } else if (action.actionType === 'create_channel') {
      const now = Date.now();
      const visibility = p.visibility === 'hidden' ? 'hidden' : 'visible';
      const isOpenPublic = visibility !== 'hidden' && Boolean(p.isOpenPublic);
      const ch: ChannelRecord = {
        id: `channel_${now}_${crypto.randomBytes(3).toString('hex')}`,
        name: String(p.name || 'قناة جديدة').trim(),
        description: String(p.description || '').trim(),
        visibility: visibility as 'visible' | 'hidden',
        isOpenPublic,
        isPrivate: !isOpenPublic,
        password: isOpenPublic ? '' : String(p.password || '').trim(),
        allowedMemberIds: [OWNER_ID],
        memberIds: [OWNER_ID],
        createdAt: now,
        updatedAt: now,
      };
      await saveChannelRecord(ch);
      await updateThreadContext({ activeChannelId: ch.id, activeChannelName: ch.name });
      resultMessage = `تم إنشاء القناة الجديدة «${ch.name}» بنجاح (${ch.isOpenPublic ? 'مفتوحة للجميع' : ch.visibility === 'hidden' ? 'مخفية' : 'مغلقة بكلمة مرور'}).`;
      targetDesc = `${ch.name} (${ch.id})`;
      navigation = { tab: 'channels', channelId: ch.id, channelName: ch.name };
    } else if (action.actionType === 'update_channel') {
      const ch = await getChannelById(String(p.channelId));
      if (!ch) throw new Error('القناة المطلوب تعديلها غير موجودة.');
      const nextVis = p.visibility !== undefined ? (p.visibility === 'hidden' ? 'hidden' : 'visible') : ch.visibility;
      const nextOpen = nextVis === 'hidden' ? false : p.isOpenPublic !== undefined ? Boolean(p.isOpenPublic) : Boolean(ch.isOpenPublic);
      const nextPwd = nextOpen ? '' : p.password !== undefined ? String(p.password).trim() : ch.password || '';
      const updated: ChannelRecord = {
        ...ch,
        name: p.name !== undefined ? String(p.name).trim() : ch.name,
        description: p.description !== undefined ? String(p.description) : ch.description,
        visibility: nextVis as 'visible' | 'hidden',
        isOpenPublic: nextOpen,
        isPrivate: !nextOpen,
        password: nextPwd,
        updatedAt: Date.now(),
      };
      await saveChannelRecord(updated);
      await updateThreadContext({ activeChannelId: updated.id, activeChannelName: updated.name });
      resultMessage = `تم تحديث إعدادات قناة «${updated.name}» بنجاح.`;
      targetDesc = `${updated.name} (${updated.id})`;
      navigation = { tab: 'channels', channelId: updated.id, channelName: updated.name };
    } else if (action.actionType === 'delete_channel') {
      const chId = String(p.channelId);
      const chName = String(p.channelName || chId);
      await deleteChannelRecord(chId);
      const thread = ensureThread();
      if (thread.activeChannelId === chId) {
        await updateThreadContext({ activeChannelId: null, activeChannelName: null });
      }
      resultMessage = `تم حذف قناة «${chName}» نهائياً.`;
      targetDesc = `${chName} (${chId})`;
    } else if (action.actionType === 'manage_channel_members') {
      const chId = String(p.channelId);
      const uid = Number(p.userId);
      const uname = String(p.userDisplayName || `#${uid}`);
      if (p.operation === 'remove') {
        await removeChannelMember(chId, uid);
        resultMessage = `تمت إزالة العضو ${uname} من قناة «${p.channelName}».`;
      } else {
        await addChannelMembers(chId, [uid]);
        resultMessage = `تمت إضافة العضو ${uname} إلى قائمة المصرح لهم في قناة «${p.channelName}».`;
      }
      targetDesc = `${p.channelName} -> ${uname}`;
    } else if (action.actionType === 'manage_user') {
      const uid = Number(p.userId);
      const uname = String(p.userDisplayName || `#${uid}`);
      if (uid === OWNER_ID) {
        throw new Error('لا يمكن تعديل رتبة أو حذف حساب المالك الرئيسي.');
      }
      if (p.operation === 'delete_user') {
        await deleteUserRecord(uid);
        resultMessage = `تم حذف حساب المستخدم ${uname} (#${uid}) بنجاح.`;
      } else {
        const nextRole = p.role === 'moderator' ? 'moderator' : 'user';
        await updateUserRecord(uid, { role: nextRole });
        resultMessage = `تم تحديث رتبة ${uname} إلى ${nextRole === 'moderator' ? 'مشرف' : 'عضو'}.`;
      }
      targetDesc = `${uname} (#${uid})`;
    } else if (action.actionType === 'pin_channel_message') {
      const pinned = await togglePinChannelMessage(String(p.channelId), String(p.messageId));
      resultMessage = pinned
        ? `تم تثبيت الرسالة (${p.messageId}) في قناة «${p.channelName}».`
        : `تم إلغاء تثبيت الرسالة (${p.messageId}) في قناة «${p.channelName}».`;
      targetDesc = `${p.channelName} (${p.messageId})`;
    }
  } catch (err: any) {
    await appendAuditLog({
      actionType: action.actionType,
      command: commandContext,
      target: targetDesc,
      status: 'error',
      details: err?.message || 'فشل تنفيذ الإجراء.',
    });
    throw err;
  }

  const nextAction: AiAssistantPendingAction = {
    ...action,
    status: 'executed',
    resultMessage,
    updatedAt: Date.now(),
  };
  store.pendingActions![action.id] = nextAction;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_pending_actions', nextAction.id, nextAction);

  await appendAuditLog({
    actionType: action.actionType,
    command: commandContext,
    target: targetDesc,
    status: 'success',
    details: resultMessage,
  });

  return { action: nextAction, navigation };
}

export async function cancelPendingAction(actionId: string): Promise<AiAssistantPendingAction> {
  const store = getAiAssistantDiskStore();
  const action = store.pendingActions?.[actionId] as AiAssistantPendingAction | undefined;
  if (!action) throw new Error('لم يتم العثور على الإجراء المعلق.');
  if (action.status !== 'pending') {
    throw new Error('هذا الإجراء لم يعد معلقاً.');
  }
  const next: AiAssistantPendingAction = {
    ...action,
    status: 'cancelled',
    resultMessage: 'تم إلغاء الإجراء بناءً على طلب المالك.',
    updatedAt: Date.now(),
  };
  store.pendingActions![action.id] = next;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_pending_actions', next.id, next);

  await appendAuditLog({
    actionType: action.actionType,
    command: 'إلغاء إجراء معلق',
    target: action.titleAr,
    status: 'cancelled',
    details: action.summaryAr,
  });

  return next;
}

async function createInteractionAccountChoicePrompt(params: {
  channel: ChannelRecord;
  count: number;
  topic: string;
  intervalSeconds: number;
  commandText: string;
}): Promise<{
  action: AiAssistantPendingAction;
  existingCount: number;
  replyText: string;
}> {
  const store = getAiAssistantDiskStore();
  const safeCount = Math.max(1, Math.min(30, Math.floor(Number(params.count) || 3)));
  const allUsers = await getAllUsersList();
  const eligibleExisting = allUsers
    .filter((u) => !isProtectedOwnerOrSystemUser(u))
    .map((u) => ({
      id: Number(u.id),
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      avatarUrl: u.avatarUrl || null,
    }));

  // Cancel any stale unresolved choose_interaction_accounts prompt so UI shows the latest one cleanly
  for (const prev of Object.values(store.pendingActions || {}) as AiAssistantPendingAction[]) {
    if (prev && prev.actionType === 'choose_interaction_accounts' && prev.status === 'pending') {
      prev.status = 'cancelled';
      prev.resultMessage = 'تم استبداله بطلب أحدث.';
      prev.updatedAt = Date.now();
      await tryWriteFirestoreDoc('ai_assistant_pending_actions', prev.id, prev);
    }
  }

  const now = Date.now();
  const action: AiAssistantPendingAction = {
    id: makeId('aiact'),
    ownerId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    actionType: 'choose_interaction_accounts',
    titleAr: `تجهيز ${safeCount} مشاركين في قناة «${params.channel.name}»`,
    summaryAr: `الموضوع: "${params.topic}"${params.intervalSeconds > 0 ? ` (بفاصل ${params.intervalSeconds} ثانية)` : ''}\nاختر طريقة تحديد الحسابات قبل توليد التفاعلات باللهجة اليمنية:`,
    payload: {
      channelId: params.channel.id,
      channelName: params.channel.name,
      count: safeCount,
      topic: params.topic,
      intervalSeconds: clampIntervalSeconds(params.intervalSeconds),
      existingAccounts: eligibleExisting,
    },
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };

  store.pendingActions![action.id] = action;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);

  await updateThreadContext({
    activeSection: 'channels',
    activeChannelId: params.channel.id,
    activeChannelName: params.channel.name,
  });

  await appendAuditLog({
    actionType: 'choose_interaction_accounts',
    command: params.commandText,
    target: `${params.channel.name} (${params.channel.id})`,
    status: 'pending',
    details: `تم عرض خياري الحسابات (إنشاء جديد أو اختيار من الحالية: ${eligibleExisting.length}) لـ ${safeCount} مشاركين حول "${params.topic}".`,
  });

  const replyText = [
    `تم تحديد القناة «${params.channel.name}» والموضوع: "${params.topic}" لعدد ${safeCount} مشاركين.`,
    '',
    'قبل توليد المواضيع باللهجة اليمنية، اختر إحدى الطريقتين التاليتين (من الأزرار أدناه أو بالرد في المحادثة):',
    `1️⃣ إنشاء ${safeCount} حسابات جديدة بأسماء يمنية ثم توليد المواضيع باللهجة اليمنية.`,
    `2️⃣ اختيار من الحسابات الحالية (${eligibleExisting.length} حساب متاح) ثم توليد المواضيع باللهجة اليمنية.`,
  ].join('\n');

  return { action, existingCount: eligibleExisting.length, replyText };
}

export async function resolveInteractionAccountsChoice(
  actionId: string,
  opts: {
    mode: 'create_new' | 'select_existing';
    selectedUserIds?: number[];
    commandContext?: string;
    fromChatFlow?: boolean;
  }
): Promise<{
  action: AiAssistantPendingAction;
  draft: AiAssistantDraft;
  createdAccounts: CreatedUserCredential[];
  replyText: string;
  navigation: AiNavigationDirective;
  assistantMessage?: AiAssistantMessage;
}> {
  const store = getAiAssistantDiskStore();
  const action = store.pendingActions?.[actionId] as AiAssistantPendingAction | undefined;
  if (!action || action.actionType !== 'choose_interaction_accounts') {
    throw new Error('لم يتم العثور على طلب اختيار الحسابات المعلق.');
  }
  if (action.status !== 'pending') {
    throw new Error(action.status === 'executed' ? 'تم تنفيذ هذا الاختيار مسبقاً.' : 'تم إلغاء هذا الطلب.');
  }

  const p = action.payload || {};
  const ch = await getChannelById(String(p.channelId || ''));
  if (!ch) {
    throw new Error(`القناة المستهدفة (${p.channelName || p.channelId}) لم تعد موجودة.`);
  }

  const count = Math.max(1, Math.min(30, Math.floor(Number(p.count) || 3)));
  const topic = String(p.topic || 'موضوع التداول').trim();
  const intervalSeconds = clampIntervalSeconds(p.intervalSeconds);

  let selectedAccounts: SelectedAccountForDraft[] = [];
  let createdAccounts: CreatedUserCredential[] = [];

  if (opts.mode === 'create_new') {
    const batch = await createUsersBatchViaAssistant({ count });
    if (batch.created.length === 0) {
      throw new Error(batch.failed[0]?.error || 'تعذر إنشاء الحسابات الجديدة.');
    }
    createdAccounts = batch.created;
    selectedAccounts = batch.created.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      avatarUrl: null,
    }));
  } else {
    const allUsers = await getAllUsersList();
    const eligible = allUsers.filter((u) => !isProtectedOwnerOrSystemUser(u));
    if (eligible.length === 0) {
      throw new Error('لا توجد حسابات أعضاء حالية متاحة للاختيار. يمكنك اختيار «إنشاء حسابات جديدة» بدلاً من ذلك.');
    }

    const requestedIds = Array.isArray(opts.selectedUserIds)
      ? opts.selectedUserIds.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
      : [];

    if (requestedIds.length > 0) {
      const byId = new Map(eligible.map((u) => [Number(u.id), u]));
      for (const uid of requestedIds) {
        const found = byId.get(uid);
        if (found) {
          selectedAccounts.push({
            id: Number(found.id),
            username: found.username,
            displayName: found.displayName,
            avatarUrl: found.avatarUrl || null,
          });
        }
      }
      if (selectedAccounts.length === 0) {
        throw new Error('لم يتم العثور على أي حساب صالح ضمن الحسابات المحددة.');
      }
    } else {
      selectedAccounts = eligible.slice(0, count).map((u) => ({
        id: Number(u.id),
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl || null,
      }));
    }
  }

  const recentMsgs = await getChannelMessages(ch.id, 10);
  const sampleTexts = recentMsgs.map((m) => m.text).filter((x): x is string => Boolean(x));

  const { items } = await generateDiverseVirtualPersonasWithEngine({
    topic,
    count: selectedAccounts.length,
    channelName: ch.name,
    recentMessagesSample: sampleTexts,
    selectedAccounts,
  });

  const now = Date.now();
  const draft: AiAssistantDraft = {
    id: makeId('aidraft'),
    ownerId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    channelId: ch.id,
    channelName: ch.name,
    topic,
    status: 'pending_approval',
    items,
    intervalSeconds,
    nextPublishAt: null,
    createdAt: now,
    updatedAt: now,
  };

  store.drafts![draft.id] = draft;

  const resultMessage =
    opts.mode === 'create_new'
      ? `تم إنشاء ${createdAccounts.length} حسابات جديدة وتوليد ${items.length} تفاعل باللهجة اليمنية.`
      : `تم اختيار ${selectedAccounts.length} من الحسابات الحالية وتوليد ${items.length} تفاعل باللهجة اليمنية.`;

  const executedAction: AiAssistantPendingAction = {
    ...action,
    status: 'executed',
    resultMessage,
    updatedAt: Date.now(),
  };
  store.pendingActions![action.id] = executedAction;
  saveAiAssistantDiskStore();

  await Promise.all([
    tryWriteFirestoreDoc('ai_assistant_drafts', draft.id, draft),
    tryWriteFirestoreDoc('ai_assistant_pending_actions', executedAction.id, executedAction),
  ]);

  await updateThreadContext({
    activeSection: 'channels',
    activeChannelId: ch.id,
    activeChannelName: ch.name,
  });

  await appendAuditLog({
    actionType: 'prepare_virtual_personas',
    command: opts.commandContext || (opts.mode === 'create_new' ? 'إنشاء حسابات جديدة وتوليد باللهجة اليمنية' : 'اختيار حسابات حالية وتوليد باللهجة اليمنية'),
    target: `${ch.name} (${ch.id})`,
    status: 'pending',
    details: `${resultMessage} حول "${topic}" بانتظار اعتماد المالك.`,
  });

  const namesList = selectedAccounts.slice(0, 10).map((a) => a.displayName).join('، ');
  const replyText = [
    opts.mode === 'create_new'
      ? `تم إنشاء ${createdAccounts.length} حسابات جديدة بصلاحية عضو (user)، وتوليد ${items.length} تفاعلات باللهجة اليمنية حول "${topic}" لقناة «${ch.name}».`
      : `تم اختيار ${selectedAccounts.length} من الحسابات الحالية (${namesList}${selectedAccounts.length > 10 ? ' ...' : ''}) وتوليد ${items.length} تفاعلات باللهجة اليمنية حول "${topic}" لقناة «${ch.name}».`,
    'يمكنك الآن مراجعة النصوص وتعديلها أو تحديد فاصل زمني ثم الضغط على «اعتماد ونشر» أو الرد بـ «اعتمد».',
  ].join('\n');

  const navigation: AiNavigationDirective = {
    tab: 'channels',
    channelId: ch.id,
    channelName: ch.name,
  };

  let assistantMessage: AiAssistantMessage | undefined;
  if (!opts.fromChatFlow) {
    assistantMessage = await appendChatMessage({
      role: 'assistant',
      text: replyText,
      toolSteps: [
        ...(createdAccounts.length > 0
          ? [
              {
                toolName: 'create_user_accounts',
                labelAr: `إنشاء ${createdAccounts.length} حسابات (user)`,
                status: 'ok' as const,
                summaryAr: `تم تسجيل ${createdAccounts.length} حساب فعلي.`,
              },
            ]
          : []),
        {
          toolName: 'prepare_virtual_persona_interactions',
          labelAr: `توليد ${items.length} تفاعلات باللهجة اليمنية`,
          status: 'pending_confirmation' as const,
          summaryAr: `جاهزة للمراجعة والاعتماد لقناة «${ch.name}».`,
        },
      ],
      draftId: draft.id,
      navigation,
      createdAccounts: createdAccounts.length > 0 ? createdAccounts : null,
      timestamp: Date.now(),
    });
  }

  return {
    action: executedAction,
    draft,
    createdAccounts,
    replyText,
    navigation,
    assistantMessage,
  };
}

export async function resetOwnerAiConversation(): Promise<void> {
  const store = getAiAssistantDiskStore();
  const prevMsgs = [...(store.messages || [])];
  store.messages = [];
  saveAiAssistantDiskStore();
  for (const m of prevMsgs) {
    if (m?.id) void tryDeleteFirestoreDoc('ai_assistant_messages', m.id);
  }
  await updateThreadContext({
    activeSection: 'ai_assistant',
    activeChannelId: null,
    activeChannelName: null,
    activePartnerId: null,
  });
  await appendAuditLog({
    actionType: 'reset_conversation',
    command: 'مسح سجل محادثة المساعد الذكي',
    target: OWNER_THREAD_ID,
    status: 'success',
    details: 'تم بدء جلسة محادثة جديدة ونظيفة للمالك سليم.',
  });
}

function getLatestPending(turnStartedAt: number): { draft: AiAssistantDraft | null; action: AiAssistantPendingAction | null } {
  const store = getAiAssistantDiskStore();
  const drafts = Object.values(store.drafts || {})
    .filter((d: any) => d?.status === 'pending_approval' && d.createdAt < turnStartedAt)
    .sort((a: any, b: any) => b.createdAt - a.createdAt) as AiAssistantDraft[];
  const actions = Object.values(store.pendingActions || {})
    .filter((a: any) => a?.status === 'pending' && a.createdAt < turnStartedAt)
    .sort((a: any, b: any) => b.createdAt - a.createdAt) as AiAssistantPendingAction[];
  return { draft: drafts[0] || null, action: actions[0] || null };
}

function toAsciiDigits(s: string): string {
  return String(s || '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function parseArabicCount(text: string): number | null {
  const ascii = toAsciiDigits(text);
  const digitMatch = ascii.match(/\b(\d{1,2})\b/);
  if (digitMatch) {
    const n = Number(digitMatch[1]);
    if (n >= 1 && n <= 30) return n;
  }
  const norm = normalizeArabicForMatch(ascii);
  if (/(?:حسابين|مستخدمين اثنين|عضوين|شخصيتين|تفاعلين|رسالتين)/.test(norm)) return 2;
  const wordsMap: Array<[RegExp, number]> = [
    [/(?:^|\s)ل?(?:ثلاثين|ثلاثون)(?=\s|$|[،.])/, 30],
    [/(?:^|\s)ل?(?:عشرين|عشرون)(?=\s|$|[،.])/, 20],
    [/(?:^|\s)ل?(?:خمسه عشر|خمس عشره|خمسطعش)(?=\s|$|[،.])/, 15],
    [/(?:^|\s)ل?(?:اثنا عشر|اثني عشر|اثنتا عشره|اطنعش)(?=\s|$|[،.])/, 12],
    [/(?:^|\s)ل?(?:عشره|عشر)(?=\s|$|[،.])/, 10],
    [/(?:^|\s)ل?(?:تسعه|تسع)(?=\s|$|[،.])/, 9],
    [/(?:^|\s)ل?(?:ثمانيه|ثماني|ثمان)(?=\s|$|[،.])/, 8],
    [/(?:^|\s)ل?(?:سبعه|سبع)(?=\s|$|[،.])/, 7],
    [/(?:^|\s)ل?(?:سته|ست)(?=\s|$|[،.])/, 6],
    [/(?:^|\s)ل?(?:خمسه|خمس)(?=\s|$|[،.])/, 5],
    [/(?:^|\s)ل?(?:اربعه|اربع)(?=\s|$|[،.])/, 4],
    [/(?:^|\s)ل?(?:ثلاثه|ثلاث)(?=\s|$|[،.])/, 3],
    [/(?:^|\s)ل?(?:اثنين|اثنان)(?=\s|$|[،.])/, 2],
    [/(?:^|\s)ل?(?:واحد|واحده)(?=\s|$|[،.])/, 1],
  ];
  for (const [re, num] of wordsMap) {
    if (re.test(norm)) return num;
  }
  return null;
}

function parsePersonaInteractionCount(text: string): number | null {
  const ascii = toAsciiDigits(text)
    .replace(/\d+(?:\.\d+)?\s*(?:دولار[اً]?|دولارات|\$|usd|نقطه|نقطة|نقاط|بيب|pips?|%|بالمئه|بالميه|ثانيه|ثانية|ثواني|دقيقه|دقيقة|دقائق)/gi, ' ')
    .replace(/\$\s*\d+(?:\.\d+)?/g, ' ')
    .replace(/([a-zA-Z])\d+/g, '$1');

  const norm = normalizeArabicForMatch(ascii);

  // Explicit duals first
  if (/(?:^|\s)ل?(?:شخصيتين|تفاعلين|ردين|تعليقين|مشاركين|عضوين)(?=\s|$|[،.])/.test(norm)) {
    return 2;
  }

  // Digit adjacent to persona/interaction noun (also supports no-space like "10شخصيات")
  const digitNoun = norm.match(
    /(?:^|\s)ل?[ـ]?\s*(\d{1,2})\s*(?:شخصيه|شخصيات|تفاعلات|تفاعل|ردود|رد|تعليقات|تعليق|حوارات|حوار|مشاركات|مشارك|مشاركين|اعضاء|عضو)/
  );
  if (digitNoun) {
    const n = Number(digitNoun[1]);
    if (n >= 1 && n <= 30) return n;
  }

  // Digit shortly after creation / request verb
  const verbDigit = norm.match(
    /(?:اريد|ابغي|ابي|جهز|حضر|انشئ|اكتب|رتب|صغ|اعمل|سو|سوي|ولد|كون|اقترح|اضف|زيد)(?:\s+لي)?(?:\s+تفاعلات)?\s+(?:ل?[ـ]?\s*)?(\d{1,2})\b/
  );
  if (verbDigit) {
    const n = Number(verbDigit[1]);
    if (n >= 1 && n <= 30) return n;
  }

  // Arabic number word anywhere in sanitized norm
  const wordCount = parseArabicCount(norm);
  if (wordCount !== null) return wordCount;

  return null;
}

async function parsePersonaDiscussionRequest(asciiInput: string, norm: string): Promise<{
  isRequest: boolean;
  count: number;
  channelQuery: string | null;
  topic: string;
  intervalSeconds: number;
  explicitAccountMode: 'create_new' | 'select_existing' | null;
} | null> {
  const hasPersonaOrInteractionNoun =
    /(?:تفاعل|تفاعلات|تفاعلين|شخصي|شخصيه|شخصيات|شخصيتين|حوار|حوارات|ردود|تعليقات|مشاركين|يتكلم|يتحدث|يتفاعل|يناقش)/.test(norm);
  const hasVerbOrWant =
    /(?:اريد|ابغي|ابي|خل|اجعل|يتكلم|يتحدث|يتفاعل|يناقش|يطلب|يطلبو|يطلبوا|تتطلب|تطلب|تطلبو|يسال|يسالو|يشكر|يشكرو|انشئ|انشاء|جهز|حضر|اكتب|رتب|صغ|اعمل|سو|سوي|ولد|كون|اقترح|نظم|ابدا|شغل|اضف)/.test(norm);
  const isPureAccountRequest =
    /(?:حساب\s+مستخدم|حسابات\s+مستخدمين|حسابات\s+فعليه|عضو\s+جديد)/.test(norm) &&
    !/(?:يتكلم|يتحدث|يتفاعل|يناقش|يطلب|تتطلب|تطلب|يسال|يشكر|موضوع|قناه|قناة)/.test(norm);
  const hasOtherAdminVerb = /(?:احذف|عد[ّ]?ل اسم|غي[ّ]?ر اسم|كلمه مرور|اقرا|اقرأ|اعرض المستخدمين)/.test(norm);

  if (!hasPersonaOrInteractionNoun || !hasVerbOrWant || isPureAccountRequest || hasOtherAdminVerb) {
    return null;
  }

  const parsedCount = parsePersonaInteractionCount(asciiInput);
  const count = parsedCount ?? 3;
  const intervalSeconds = clampIntervalSeconds(parseIntervalSecondsFromArabic(asciiInput) ?? 0);

  let explicitAccountMode: 'create_new' | 'select_existing' | null = null;
  if (/(?:انشئ حسابات جديده|انشاء حسابات جديده|بحسابات جديده|حسابات جديده)/.test(norm)) {
    explicitAccountMode = 'create_new';
  } else if (/(?:من الحسابات الحاليه|الحسابات الحاليه|الحسابات الموجوده|من الاعضاء الحاليين|بالحسابات الحاليه)/.test(norm)) {
    explicitAccountMode = 'select_existing';
  }

  let channelQuery: string | null = null;
  let workingForTopic = asciiInput;

  const prefixNavMatch = asciiInput.match(
    /(?:توج[ّ]?ه|اذهب|انتقل|ادخل|روح|افتح)\s+(?:الى|إلى|لـ?|علي|على)?\s*(.+?)\s+(?:و|ثم)\s*/i
  );
  if (prefixNavMatch) {
    channelQuery = prefixNavMatch[1].replace(/^(?:قناه|قناة|غرفه|غرفة|روم)\s+/i, '').trim();
    workingForTopic = asciiInput.slice(prefixNavMatch[0].length);
  } else {
    const channelPrepMatch = asciiInput.match(/(?:في|داخل|لقناة|لقناه|بقناة|بقناه)\s+/i);
    if (channelPrepMatch && channelPrepMatch.index !== undefined) {
      const prepStart = channelPrepMatch.index;
      const afterPrepOffset = prepStart + channelPrepMatch[0].length;
      const afterPrep = asciiInput.slice(afterPrepOffset);

      // 1. Try matching against actual channel names & known aliases cleanly first
      const knownChannels = await getChannelsForUser(OWNER_ID, 'owner');
      const knownChannelPhrases = [
        'القناة العامة',
        'القناه العامه',
        'القناة العامه',
        'القناه العامة',
        'الدردشة العامة',
        'الدردشه العامه',
        ...knownChannels.map((c) => c.name).filter(Boolean),
      ]
        .map((n) => n.trim())
        .filter((n) => n.length >= 2)
        .sort((a, b) => b.length - a.length);

      let matchedChannelSpanLen = 0;
      const afterPrepCleanPrefix = afterPrep.replace(/^(?:قناه|قناة|غرفه|غرفة|روم)\s+/i, '');
      const prefixDiffLen = afterPrep.length - afterPrepCleanPrefix.length;
      const normAfterPrefix = normalizeArabicForMatch(afterPrepCleanPrefix);

      for (const phrase of knownChannelPhrases) {
        const normPhrase = normalizeArabicForMatch(phrase);
        if (normAfterPrefix.startsWith(normPhrase)) {
          const nextChar = afterPrepCleanPrefix.slice(phrase.length, phrase.length + 1);
          if (!nextChar || /\s/.test(nextChar)) {
            channelQuery = phrase.replace(/^(?:قناه|قناة|غرفه|غرفة|روم)\s+/i, '').trim();
            matchedChannelSpanLen = prefixDiffLen + phrase.length;
            break;
          }
        }
      }

      if (matchedChannelSpanLen === 0) {
        const inChannelMatch = afterPrep.match(
          /^(?:قناه|قناة|غرفه|غرفة|روم)?\s*(.+?)(?=\s+(?:حول|عن|بخصوص|بشأن|بشان|كل\s+\d|يطلب[و]?ا?|تتطلب|تطلب[و]?ا?|يس[أا]ل[و]?ا?|تس[أا]ل[و]?ا?|يشكر[و]?ا?|تشكر[و]?ا?|يتكلم[و]?ا?|تتكلم|يتحدث[و]?ا?|تتحدث|يتفاعل[و]?ا?|يناقش[و]?ا?|يقول[و]?ا?|تقول|يعلق[و]?ا?|يمدح[و]?ا?|يبارك[و]?ا?|يطالب[و]?ا?|ينصح[و]?ا?|يدع[و]?ا?|و(?:جهز|انشئ|يتكلم|تفاعل|يطلب))|$)/i
        );
        if (inChannelMatch) {
          const candidateCh = inChannelMatch[1].trim();
          const normCh = normalizeArabicForMatch(candidateCh);
          if (!/^(?:معينه|محدده|محدد|نفسها|الحاليه|النشطه|هذه)$/.test(normCh)) {
            channelQuery = candidateCh.replace(/^(?:قناه|قناة|غرفه|غرفة|روم)\s+/i, '').trim();
          }
          matchedChannelSpanLen = inChannelMatch[0].length;
        }
      }

      if (matchedChannelSpanLen > 0) {
        workingForTopic = (asciiInput.slice(0, prepStart) + ' ' + asciiInput.slice(afterPrepOffset + matchedChannelSpanLen)).trim();
      }
    }
  }

  workingForTopic = workingForTopic
    .replace(/كل\s*\d+\s*(?:ثانيه|ثانية|ثواني|دقيقه|دقيقة|دقائق).*$/i, '')
    .replace(/(?:بحسابات جديده|من الحسابات الحاليه|الحسابات الحاليه|الحسابات الموجوده).*$/i, '')
    .replace(/\b(?:باللهجه|باللهجة|بلهجه|بلهجة)\s+(?:اليمنيه|اليمنية|يمنيه|يمنية)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Extract direct speech-act phrases (e.g. "يطلبو من سليم يرسل صفقات", "تتطلب من سليم ...", "يشكرو سليم ...")
  const speechActMatch = workingForTopic.match(
    /((?:يطلب[و]?ا?|تتطلب|تطلب[و]?ا?|يس[أا]ل[و]?ا?|تس[أا]ل[و]?ا?|يشكر[و]?ا?|تشكر[و]?ا?|يمدح[و]?ا?|تمدح[و]?ا?|يبارك[و]?ا?|تبارك[و]?ا?|يهنئ[و]?ا?|يطالب[و]?ا?|ينصح[و]?ا?|يدع[و]?ا?|يقول[و]?ا?|تقول[و]?ا?|يعلق[و]?ا?|تعلق[و]?ا?|يشجع[و]?ا?)\s+.+)$/i
  );

  const topicMatch = workingForTopic.match(/(?:حول|عن|بخصوص|بشأن|بشان|لصفقة|لصفقه|بمناسبة|بمناسبه)\s+(.+)$/i);

  let rawTopic = '';
  if (speechActMatch) {
    rawTopic = speechActMatch[1].trim();
  } else if (topicMatch) {
    rawTopic = topicMatch[1].trim();
  } else {
    const residual = workingForTopic
      .replace(/^(?:اريد|أريد|ابغي|أبغي|ابي|جهز|حض[ّ]?ر|انشئ|أنشئ|اكتب|رتب|اعمل|سو|سوي|ولد|كون|خل|اجعل)\s+(?:لي\s+)?/i, '')
      .replace(/^(?:ل?[ـ]?\s*)?(?:\d{1,2}\s*)?(?:الشخصيات|شخصيات|شخصيه|شخصية|شخصيتين|اعضاء|أعضاء|الاعضاء|الأعضاء|تفاعلات|تفاعل)\s*/i, '')
      .replace(/^(?:تتكلم|يتكلم[و]?ا?|تتحدث|يتحدث[و]?ا?|تناقش|يناقش[و]?ا?|تتفاعل|يتفاعل[و]?ا?)\s*/i, '')
      .trim();
    if (residual.length >= 3) {
      rawTopic = residual;
    }
  }
  rawTopic = rawTopic.replace(/^(?:موضوع)\s+/i, '').trim();

  const hasExplicitContext =
    rawTopic.length >= 2 ||
    Boolean(channelQuery) ||
    /(?:توج[ّ]?ه|اذهب|انتقل|في\s+(?:قناه|قناة)|موضوع|يتكلم|يتحدث|يناقش|يطلب|تتطلب|تطلب|يسال|يشكر)/.test(norm);

  if (!hasExplicitContext) {
    return null;
  }

  return {
    isRequest: true,
    count,
    channelQuery,
    topic: rawTopic,
    intervalSeconds,
    explicitAccountMode,
  };
}

function parseIntervalSecondsFromArabic(text: string): number | undefined {
  const ascii = toAsciiDigits(text);
  const norm = normalizeArabicForMatch(ascii);
  if (/(?:فورا|دفعه واحده|بدون انتظار|بدون فاصل)/.test(norm)) return 0;
  const secMatch = norm.match(/كل\s*(\d+)\s*(?:ثانيه|ثواني|ث)\b/);
  if (secMatch) return clampIntervalSeconds(Number(secMatch[1]));
  const minNumMatch = norm.match(/كل\s*(\d+)\s*(?:دقيقه|دقائق|د)\b/);
  if (minNumMatch) return clampIntervalSeconds(Number(minNumMatch[1]) * 60);
  if (/كل\s*(?:دقيقتين)\b/.test(norm)) return 120;
  if (/كل\s*(?:دقيقه|دقيقه واحده)\b/.test(norm)) return 60;
  if (/كل\s*(?:نصف دقيقه|نص دقيقه)\b/.test(norm)) return 30;
  return undefined;
}

function mapArabicSectionTarget(raw: string): AiNavigationDirective['tab'] | null {
  const norm = normalizeArabicForMatch(raw);
  if (/(?:لوحه الاداره|الاداره|قسم الاداره|اداره المستخدمين|اداره القنوات)/.test(norm)) return 'admin';
  if (/(?:الرئيسيه|الداشبورد|لوحه التحكم|الصفحه الرئيسيه)/.test(norm)) return 'dashboard';
  if (/(?:المحادثات الخاصه|الخاص|الرسائل الخاصه)/.test(norm)) return 'private_chat';
  if (/(?:السجل|التاريخ|سجل الصفقات)/.test(norm)) return 'history';
  if (/(?:خريطه الطريق|خطه الطريق|المحطات|التحدي)/.test(norm)) return 'roadmap';
  if (/(?:الاعدادات|الضبط)/.test(norm)) return 'settings';
  if (/(?:القنوات|قسم القنوات)/.test(norm)) return 'channels';
  return null;
}

async function resolveUserCandidatesForDirect(query: string) {
  const clean = String(query || '').trim().replace(/^#/, '').replace(/^@/, '');
  const all = await getAllUsersList();
  if (!clean) return [];
  if (/^\d+$/.test(clean)) {
    const idNum = Number(clean);
    return all.filter((u) => Number(u.id) === idNum);
  }
  const norm = normalizeArabicForMatch(clean);
  const exact = all.filter(
    (u) => normalizeArabicForMatch(u.username) === norm || normalizeArabicForMatch(u.displayName) === norm
  );
  if (exact.length > 0) return exact;
  return all.filter(
    (u) => normalizeArabicForMatch(u.username).includes(norm) || normalizeArabicForMatch(u.displayName).includes(norm)
  );
}

type DirectChatResult = {
  userMessage: AiAssistantMessage;
  assistantMessage: AiAssistantMessage;
  thread: AiAssistantThread;
  activeDraft: AiAssistantDraft | null;
  activePendingAction: AiAssistantPendingAction | null;
  createdAccounts?: CreatedUserCredential[];
  handledByServerDirect: true;
};

async function finalizeDirectReply(params: {
  cleanInput: string;
  turnStartedAt: number;
  replyText: string;
  toolSteps: AiToolStep[];
  thread: AiAssistantThread;
  draftId?: string | null;
  pendingActionId?: string | null;
  navigation?: AiNavigationDirective | null;
  createdAccounts?: CreatedUserCredential[];
}): Promise<DirectChatResult> {
  const store = getAiAssistantDiskStore();
  const userMessage = await appendChatMessage({
    role: 'user',
    text: params.cleanInput,
    timestamp: params.turnStartedAt,
  });
  const assistantMessage = await appendChatMessage({
    role: 'assistant',
    text: params.replyText,
    toolSteps: params.toolSteps.length > 0 ? params.toolSteps : null,
    draftId: params.draftId ?? null,
    pendingActionId: params.pendingActionId ?? null,
    navigation: params.navigation ?? null,
    createdAccounts: params.createdAccounts,
    timestamp: Date.now(),
  });
  const activeDraft = params.draftId ? (store.drafts?.[params.draftId] as AiAssistantDraft) || null : null;
  const activePendingAction = params.pendingActionId
    ? (store.pendingActions?.[params.pendingActionId] as AiAssistantPendingAction) || null
    : null;
  return {
    userMessage,
    assistantMessage,
    thread: params.thread,
    activeDraft,
    activePendingAction,
    ...(params.createdAccounts && params.createdAccounts.length > 0 ? { createdAccounts: params.createdAccounts } : {}),
    handledByServerDirect: true,
  };
}

async function tryExecuteDirectArabicCommand(cleanInput: string, turnStartedAt: number): Promise<DirectChatResult | null> {
  const store = getAiAssistantDiskStore();
  let thread = ensureThread();
  const prePending = getLatestPending(turnStartedAt);
  const asciiInput = toAsciiDigits(cleanInput).trim();
  const norm = normalizeArabicForMatch(asciiInput);
  const wordsCount = norm.split(/\s+/).filter(Boolean).length;

  // A0. Resolve pending choose_interaction_accounts via text reply (0 Gemini calls)
  if (prePending.action && prePending.action.actionType === 'choose_interaction_accounts') {
    const wantsCancelChoice =
      wordsCount <= 6 && /^(?:الغ|ألغ|الغاء|الغي|رفض|توقف|كنسل)(?:\s+(?:الطلب|العمليه|الاختيار))?[!؟.]*$/.test(norm);
    const wantsCreateNew =
      /(?:انشئ|انشاء|حسابات جديده|حساب جديد|جديده|الخيار الاول|الاختيار الاول|الاول)/.test(norm) ||
      norm === '1';
    const wantsSelectExisting =
      !wantsCreateNew &&
      (/(?:اختيار من الحسابات الحاليه|الحسابات الحاليه|الحسابات الموجوده|من الحسابات الحاليه|من الاعضاء الحاليين|حسابات حاليه|حاليه|الخيار الثاني|الاختيار الثاني|الثاني)/.test(norm) ||
        norm === '2');

    if (wantsCancelChoice) {
      const cancelled = await cancelPendingAction(prePending.action.id);
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText: `تم إلغاء طلب تجهيز التفاعلات (${cancelled.titleAr}).`,
        toolSteps: [
          {
            toolName: 'confirm_pending',
            labelAr: 'إلغاء الطلب',
            status: 'ok',
            summaryAr: cancelled.titleAr,
          },
        ],
      });
    }

    if (wantsCreateNew || wantsSelectExisting) {
      try {
        const res = await resolveInteractionAccountsChoice(prePending.action.id, {
          mode: wantsCreateNew ? 'create_new' : 'select_existing',
          commandContext: cleanInput,
          fromChatFlow: true,
        });
        return finalizeDirectReply({
          cleanInput,
          turnStartedAt,
          thread,
          draftId: res.draft.id,
          navigation: res.navigation,
          createdAccounts: res.createdAccounts,
          replyText: res.replyText,
          toolSteps: [
            ...(res.createdAccounts.length > 0
              ? [
                  {
                    toolName: 'create_user_accounts',
                    labelAr: `إنشاء ${res.createdAccounts.length} حسابات (user)`,
                    status: 'ok' as const,
                    summaryAr: `تم تسجيل ${res.createdAccounts.length} حساب فعلي.`,
                  },
                ]
              : []),
            {
              toolName: 'prepare_virtual_persona_interactions',
              labelAr: `توليد ${res.draft.items.length} تفاعلات باللهجة اليمنية`,
              status: 'pending_confirmation',
              summaryAr: `جاهزة للمراجعة لقناة «${res.draft.channelName}».`,
            },
          ],
        });
      } catch (err: any) {
        return finalizeDirectReply({
          cleanInput,
          turnStartedAt,
          thread,
          pendingActionId: prePending.action.id,
          replyText: err?.message || 'تعذر تنفيذ الاختيار المطلوب.',
          toolSteps: [
            {
              toolName: 'resolve_interaction_accounts',
              labelAr: 'تحديد حسابات المشاركين',
              status: 'error',
              summaryAr: err?.message || 'تعذر التنفيذ.',
            },
          ],
        });
      }
    }
  }

  // A. Approve or cancel pending draft/action directly (0 Gemini calls)
  if (prePending.draft || (prePending.action && prePending.action.actionType !== 'choose_interaction_accounts')) {
    const isCancelPhrase =
      wordsCount <= 6 &&
      /^(?:الغ|ألغ|الغاء|الغي|رفض|توقف|لا تنشر|لا تنفذ|كنسل)(?:\s+(?:المسوده|الاجراء|العمليه|الكل))?[!؟.]*$/.test(norm);
    const strippedInterval = norm
      .replace(/كل\s*\d+\s*(?:ثانيه|ثواني|ث|دقيقه|دقائق|د)/g, '')
      .replace(/كل\s*(?:دقيقتين|دقيقه|نصف دقيقه|نص دقيقه)/g, '')
      .replace(/(?:فورا|دفعه واحده|الان)/g, '')
      .trim();
    const isApprovePhrase =
      strippedInterval.split(/\s+/).filter(Boolean).length <= 5 &&
      /^(?:اعتمد|اعتماد|موافق|اوافق|نعم|انشرها|انشر|ابدا النشر|نفذ|تاكيد|اكد|تمام)(?:\s+(?:المسوده|الاجراء|العمليه|التفاعلات|النشر|ونفذ|وانشر))?[!؟.]*$/.test(
        strippedInterval
      );

    if (isCancelPhrase) {
      if (prePending.draft) {
        const cancelled = await cancelDraft(prePending.draft.id);
        return finalizeDirectReply({
          cleanInput,
          turnStartedAt,
          thread,
          replyText: `تم إلغاء مسودة التفاعلات (${cancelled.items.length} تفاعلات) لقناة «${cancelled.channelName}» بناءً على أمرك.`,
          toolSteps: [
            {
              toolName: 'confirm_pending',
              labelAr: 'إلغاء المسودة المعلقة',
              status: 'ok',
              summaryAr: `تم إلغاء ${cancelled.items.length} تفاعلات.`,
            },
          ],
        });
      }
      if (prePending.action) {
        const cancelled = await cancelPendingAction(prePending.action.id);
        return finalizeDirectReply({
          cleanInput,
          turnStartedAt,
          thread,
          replyText: `تم إلغاء الإجراء المعلق: ${cancelled.titleAr}.`,
          toolSteps: [
            {
              toolName: 'confirm_pending',
              labelAr: 'إلغاء الإجراء المعلق',
              status: 'ok',
              summaryAr: cancelled.titleAr,
            },
          ],
        });
      }
    }

    if (isApprovePhrase) {
      if (prePending.draft) {
        const intervalOverride = parseIntervalSecondsFromArabic(asciiInput);
        const res = await approveAndPublishDraft(prePending.draft.id, cleanInput, intervalOverride);
        const usedInterval = res.draft.intervalSeconds || 0;
        const nav: AiNavigationDirective = {
          tab: 'channels',
          channelId: res.draft.channelId,
          channelName: res.draft.channelName,
          messageId: res.publishedMessages[res.publishedMessages.length - 1]?.id || null,
        };
        const replyText = res.scheduled
          ? `تم اعتماد المسودة وبدء النشر المجدول في قناة «${res.draft.channelName}»: أُرسلت الرسالة الأولى الآن، وسيُرسل باقي الـ ${res.draft.items.length} تفاعلات تلقائياً كل ${usedInterval} ثانية.`
          : `تم اعتماد ونشر ${res.publishedMessages.length} تفاعلات مباشرة في قناة «${res.draft.channelName}».`;
        return finalizeDirectReply({
          cleanInput,
          turnStartedAt,
          thread,
          navigation: nav,
          replyText,
          toolSteps: [
            {
              toolName: 'confirm_pending',
              labelAr: res.scheduled ? `بدء النشر المجدول (${res.draft.items.length})` : `نشر ${res.publishedMessages.length} تفاعلات`,
              status: 'ok',
              summaryAr: res.scheduled ? `كل ${usedInterval} ثانية في «${res.draft.channelName}»` : `تم النشر في «${res.draft.channelName}»`,
            },
          ],
        });
      }
      if (prePending.action) {
        const res = await confirmPendingAction(prePending.action.id, cleanInput);
        return finalizeDirectReply({
          cleanInput,
          turnStartedAt,
          thread,
          navigation: res.navigation || null,
          replyText: res.action.resultMessage || `تم تنفيذ الإجراء: ${res.action.titleAr}.`,
          toolSteps: [
            {
              toolName: 'confirm_pending',
              labelAr: res.action.titleAr,
              status: 'ok',
              summaryAr: res.action.resultMessage || 'تم التنفيذ بنجاح.',
            },
          ],
        });
      }
    }
  }

  // B. Direct User Account Creation (0 Gemini calls, strict role: 'user')
  const hasUserCreateVerb = /(?:انشئ|انشاء|سجل|تسجيل|اضف|اضافه|اعمل|سو|سوي|افتح|ولد|توليد|كون|جهز)/.test(norm);
  const hasUserAccountNoun = /(?:حساب|حسابات|حسابين|مستخدم|مستخدمين|مستخدمون|عضو|اعضاء|عضوين)/.test(norm);
  const mentionsChannelOrInteraction = /(?:قناه|قناة|تفاعل|تفاعلات|تفاعلين|شخصيات افتراضيه|شخصيه|شخصيات|شخصيتين|حوار|حوارات|تعليق|تعليقات)/.test(norm);
  if (hasUserCreateVerb && hasUserAccountNoun && !mentionsChannelOrInteraction) {
    let customDisplayNames: string[] | undefined;
    let customPassword: string | undefined;

    const passMatch = asciiInput.match(/(?:بكلمة مرور|بكلمه مرور|كلمة المرور|كلمه المرور|باسورد)\s+([^\s،,]+)/i);
    if (passMatch) {
      customPassword = passMatch[1].trim();
    }

    const multiNamesMatch = asciiInput.match(/(?:بأسماء|باسماء)\s+(?!يمني)(.+)$/i);
    if (multiNamesMatch) {
      const candidateNames = multiNamesMatch[1]
        .replace(/(?:بكلمة مرور|بكلمه مرور|كلمة المرور|كلمه المرور|باسورد).*$/i, '')
        .split(/[،,\n]+/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 2 && !/^(?:يمنية|يمنيه|مختلفة|مختلفه|عشوائية|عشوائيه)$/i.test(x));
      if (candidateNames.length > 0) {
        customDisplayNames = candidateNames;
      }
    } else {
      const singleNameMatch = asciiInput.match(/(?:باسم|اسمه)\s+(.+)$/i);
      if (singleNameMatch) {
        const cleanedName = singleNameMatch[1]
          .replace(/(?:بكلمة مرور|بكلمه مرور|كلمة المرور|كلمه المرور|باسورد).*$/i, '')
          .replace(/(?:بصلاحية|بصلاحيه|كعضو|عضو عادي).*$/i, '')
          .trim();
        if (cleanedName && !/^(?:يمني|يمنية|يمنيه|عشوائي)$/i.test(cleanedName)) {
          customDisplayNames = [cleanedName];
        }
      }
    }

    const explicitCount = parseArabicCount(asciiInput);
    const isPluralAccountWord = /(?:حسابات|مستخدمين|مستخدمون|اعضاء)/.test(norm);
    const count = explicitCount ?? (customDisplayNames ? customDisplayNames.length : isPluralAccountWord ? 3 : 1);

    const { created, failed } = await createUsersBatchViaAssistant({
      count,
      customDisplayNames,
      customPassword,
    });

    if (created.length === 0) {
      const errDetail = failed[0]?.error || 'تعذر إنشاء الحسابات المطلوبة.';
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText: `لم يتم إنشاء أي حساب: ${errDetail}`,
        toolSteps: [
          {
            toolName: 'create_user_accounts',
            labelAr: 'إنشاء حسابات مستخدمين',
            status: 'error',
            summaryAr: errDetail,
          },
        ],
      });
    }

    await appendAuditLog({
      actionType: 'create_user_accounts',
      command: cleanInput,
      target: created.map((u) => `@${u.username} (#${u.id})`).join(', '),
      status: 'success',
      details: `تم إنشاء ${created.length} حساب مستخدم بصلاحية user مباشرة عبر الخادم (بدون استهلاك Gemini).`,
    });

    const lines = created.map(
      (u, idx) =>
        `${idx + 1}. ${u.displayName} — اسم المستخدم: @${u.username} | كلمة المرور: ${u.password} | الصلاحية: ${u.role} (#${u.id})`
    );
    const replyText = [
      `تم تنفيذ العملية مباشرة على الخادم وإنشاء ${created.length} ${created.length === 1 ? 'حساب مستخدم' : 'حسابات مستخدمين'} بصلاحية عضو عادي (user):`,
      '',
      ...lines,
      ...(failed.length > 0 ? ['', `تنبيه: تعذر إنشاء ${failed.length} حساب (${failed.map((f) => f.error).join('، ')}).`] : []),
      '',
      'الحسابات مسجلة الآن في نظام المستخدمين ويمكن الدخول بها فوراً أو مراجعتها من لوحة الإدارة.',
    ].join('\n');

    return finalizeDirectReply({
      cleanInput,
      turnStartedAt,
      thread,
      replyText,
      createdAccounts: created,
      navigation: { tab: 'admin' },
      toolSteps: [
        {
          toolName: 'create_user_accounts',
          labelAr: `إنشاء ${created.length} حسابات (user)`,
          status: 'ok',
          summaryAr: `تم تسجيل ${created.length} حساب فعلي في النظام مباشرة.`,
        },
      ],
    });
  }

  // C. Direct List / Search Users (0 Gemini calls)
  const isListUsersCmd =
    /^(?:(?:اعرض|عرض|هات|اظهر|اعطني)\s+)?(?:كل\s+|جميع\s+|اسماء\s+|قائمه\s+|جدول\s+|بيانات\s+)*?(?:المستخدمين|الاعضاء|الحسابات)(?:\s+المسجلين)?[!؟.]*$/.test(norm) ||
    /^كم عدد\s+(?:المستخدمين|الاعضاء|الحسابات)[!؟.]*$/.test(norm) ||
    /^(?:ابحث عن|بحث عن|بيانات|معلومات)\s+(?:المستخدم|الحساب|العضو)\s+(.+)$/.test(norm);
  if (isListUsersCmd) {
    const searchMatch = asciiInput.match(/(?:ابحث عن|بحث عن|بيانات|معلومات)\s+(?:المستخدم|الحساب|العضو)\s+(.+)$/i);
    const searchQ = searchMatch ? normalizeArabicForMatch(searchMatch[1].replace(/^[@#]/, '')) : '';
    const allUsers = await getAllUsersList();
    const filtered = searchQ
      ? allUsers.filter(
          (u) =>
            String(u.id) === searchQ ||
            normalizeArabicForMatch(u.username).includes(searchQ) ||
            normalizeArabicForMatch(u.displayName).includes(searchQ)
        )
      : allUsers;

    const preview = filtered.slice(0, 30);
    const rows = preview.map(
      (u) => `• #${u.id} — ${u.displayName} (@${u.username}) | الرتبة: ${u.role}${u.warningsCount ? ` | الإنذارات: ${u.warningsCount}` : ''}`
    );
    const replyText =
      filtered.length === 0
        ? 'لم يتم العثور على مستخدمين مطابقين لبحثك.'
        : [
            searchQ ? `نتائج البحث في المستخدمين (${filtered.length}):` : `إجمالي المستخدمين المسجلين في النظام: ${filtered.length} مستخدم`,
            '',
            ...rows,
            ...(filtered.length > 30 ? ['', `... يتم عرض أول 30 مستخدم من أصل ${filtered.length}.`] : []),
          ].join('\n');

    return finalizeDirectReply({
      cleanInput,
      turnStartedAt,
      thread,
      replyText,
      toolSteps: [
        {
          toolName: 'list_users',
          labelAr: 'جلب قائمة المستخدمين',
          status: 'ok',
          summaryAr: `تم العثور على ${filtered.length} مستخدم.`,
        },
      ],
    });
  }

  // D. Direct Update User DisplayName / Password / Warnings (0 Gemini calls)
  const renameUserMatch = asciiInput.match(
    /^(?:غي[ّ]?ر|عد[ّ]?ل|تعديل|تغيير|حد[ّ]?ث)\s+(?:الاسم الظاهر|اسم العرض|اسم)\s+(?:(?:للمستخدم|لـ|المستخدم|لحساب|حساب|الحساب|العضو)\s+)?(.+?)\s+(?:الى|إلى|ليصبح)\s+(.+)$/i
  );
  if (renameUserMatch) {
    const targetQuery = renameUserMatch[1].trim();
    const newDisplayName = renameUserMatch[2].trim();
    const candidates = await resolveUserCandidatesForDirect(targetQuery);
    if (candidates.length === 0) {
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText: `لم يتم العثور على مستخدم باسم "${targetQuery}".`,
        toolSteps: [{ toolName: 'update_user_account', labelAr: 'تعديل اسم المستخدم', status: 'error', summaryAr: 'المستخدم غير موجود.' }],
      });
    }
    if (candidates.length > 1) {
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText: `يوجد أكثر من مستخدم يطابق "${targetQuery}":\n${candidates
          .slice(0, 8)
          .map((u) => `• #${u.id} ${u.displayName} (@${u.username})`)
          .join('\n')}\nيرجى تحديد @username أو #ID بدقة.`,
        toolSteps: [{ toolName: 'update_user_account', labelAr: 'تعديل اسم المستخدم', status: 'error', summaryAr: 'تطابق متعدد.' }],
      });
    }
    const target = candidates[0];
    try {
      const updated = await updateRegularUserByAssistant({ userId: target.id, displayName: newDisplayName });
      await appendAuditLog({
        actionType: 'update_user_account',
        command: cleanInput,
        target: `@${updated.username} (#${updated.id})`,
        status: 'success',
        details: `تم تعديل الاسم الظاهر إلى "${updated.displayName}".`,
      });
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText: `تم تحديث الاسم الظاهر للحساب @${updated.username} (#${updated.id}) إلى «${updated.displayName}» بنجاح.`,
        toolSteps: [{ toolName: 'update_user_account', labelAr: 'تعديل الاسم الظاهر', status: 'ok', summaryAr: updated.displayName }],
      });
    } catch (err: any) {
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText: err?.message || 'تعذر تعديل اسم المستخدم.',
        toolSteps: [{ toolName: 'update_user_account', labelAr: 'تعديل الاسم الظاهر', status: 'error', summaryAr: err?.message || 'مرفوض' }],
      });
    }
  }

  const resetPassMatch = asciiInput.match(
    /^(?:غي[ّ]?ر|عد[ّ]?ل|تعديل|تغيير|[أا]عد تعيين|[إا]عاده تعيين|[إا]عادة تعيين|جد[ّ]?د)\s+(?:كلمة المرور|كلمه المرور|كلمة مرور|كلمه مرور|كلمة السر|كلمه السر|الباسورد)\s+(?:(?:للمستخدم|لـ|المستخدم|لحساب|حساب|الحساب|العضو)\s+)?(.+?)(?:\s+(?:الى|إلى)\s+(\S+))?$/i
  );
  if (resetPassMatch) {
    const targetQuery = resetPassMatch[1].trim();
    const explicitPass = resetPassMatch[2]?.trim();
    const candidates = await resolveUserCandidatesForDirect(targetQuery);
    if (candidates.length === 0) {
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText: `لم يتم العثور على مستخدم باسم "${targetQuery}".`,
        toolSteps: [{ toolName: 'update_user_account', labelAr: 'تحديث كلمة المرور', status: 'error', summaryAr: 'المستخدم غير موجود.' }],
      });
    }
    if (candidates.length > 1) {
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText: `يوجد أكثر من مستخدم يطابق "${targetQuery}":\n${candidates
          .slice(0, 8)
          .map((u) => `• #${u.id} ${u.displayName} (@${u.username})`)
          .join('\n')}\nيرجى تحديد @username أو #ID بدقة.`,
        toolSteps: [{ toolName: 'update_user_account', labelAr: 'تحديث كلمة المرور', status: 'error', summaryAr: 'تطابق متعدد.' }],
      });
    }
    const target = candidates[0];
    try {
      const updated = await updateRegularUserByAssistant({
        userId: target.id,
        ...(explicitPass ? { password: explicitPass } : { generateRandomPassword: true }),
      });
      await appendAuditLog({
        actionType: 'update_user_account',
        command: cleanInput,
        target: `@${updated.username} (#${updated.id})`,
        status: 'success',
        details: 'تم تحديث كلمة مرور المستخدم مباشرة عبر الخادم.',
      });
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText: `تم تحديث كلمة مرور الحساب ${updated.displayName} (@${updated.username} #${updated.id}) بنجاح.\nكلمة المرور الجديدة: ${updated.newPassword}`,
        toolSteps: [{ toolName: 'update_user_account', labelAr: 'تحديث كلمة المرور', status: 'ok', summaryAr: `@${updated.username}` }],
      });
    } catch (err: any) {
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText: err?.message || 'تعذر تحديث كلمة المرور.',
        toolSteps: [{ toolName: 'update_user_account', labelAr: 'تحديث كلمة المرور', status: 'error', summaryAr: err?.message || 'مرفوض' }],
      });
    }
  }

  const clearWarnMatch = asciiInput.match(
    /^(?:صف[ّ]?ر|تصفير|امسح|[أا]زل|حذف)\s+(?:انذارات|إنذارات|تحذيرات)\s+(?:(?:للمستخدم|المستخدم|الحساب|حساب|العضو)\s+)?(.+)$/i
  );
  if (clearWarnMatch) {
    const targetQuery = clearWarnMatch[1].trim();
    const candidates = await resolveUserCandidatesForDirect(targetQuery);
    if (candidates.length === 1) {
      try {
        const updated = await updateRegularUserByAssistant({ userId: candidates[0].id, warningsCount: 0 });
        await appendAuditLog({
          actionType: 'update_user_account',
          command: cleanInput,
          target: `@${updated.username} (#${updated.id})`,
          status: 'success',
          details: 'تم تصفير الإنذارات إلى 0.',
        });
        return finalizeDirectReply({
          cleanInput,
          turnStartedAt,
          thread,
          replyText: `تم تصفير إنذارات الحساب ${updated.displayName} (@${updated.username}) بنجاح.`,
          toolSteps: [{ toolName: 'update_user_account', labelAr: 'تصفير الإنذارات', status: 'ok', summaryAr: `@${updated.username}` }],
        });
      } catch (err: any) {
        return finalizeDirectReply({
          cleanInput,
          turnStartedAt,
          thread,
          replyText: err?.message || 'تعذر تصفير الإنذارات.',
          toolSteps: [{ toolName: 'update_user_account', labelAr: 'تصفير الإنذارات', status: 'error', summaryAr: err?.message || 'مرفوض' }],
        });
      }
    }
  }

  // E. Direct Delete Non-Owner User (0 Gemini calls)
  const deleteUserMatch = asciiInput.match(
    /^(?:احذف|حذف|امسح|[أا]زل)\s+(?:حساب\s+المستخدم|المستخدم|حساب|الحساب|العضو)\s+(.+)$/i
  );
  if (deleteUserMatch && !/(?:قناه|قناة|رساله|رسالة|مسوده|مسودة)/.test(norm)) {
    const targetQuery = deleteUserMatch[1].trim();
    const candidates = await resolveUserCandidatesForDirect(targetQuery);
    if (candidates.length === 0) {
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText: `لم يتم العثور على مستخدم يطابق "${targetQuery}".`,
        toolSteps: [{ toolName: 'delete_user_account', labelAr: 'حذف مستخدم', status: 'error', summaryAr: 'غير موجود.' }],
      });
    }
    if (candidates.length > 1) {
      if (candidates.every((u) => isProtectedOwnerOrSystemUser(u))) {
        return finalizeDirectReply({
          cleanInput,
          turnStartedAt,
          thread,
          replyText: `محظور: جميع الحسابات المطابقة لـ "${targetQuery}" هي حسابات مالك/إدارة محمية ولا يمكن حذفها.`,
          toolSteps: [{ toolName: 'delete_user_account', labelAr: 'حذف مستخدم', status: 'error', summaryAr: 'حساب محمي.' }],
        });
      }
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText: `يوجد عدة مستخدمين يطابقون "${targetQuery}". حدد اسم المستخدم @username أو #ID بدقة:\n${candidates
          .slice(0, 8)
          .map((u) => `• #${u.id} ${u.displayName} (@${u.username})`)
          .join('\n')}`,
        toolSteps: [{ toolName: 'delete_user_account', labelAr: 'حذف مستخدم', status: 'error', summaryAr: 'تطابق متعدد.' }],
      });
    }
    const target = candidates[0];
    if (isProtectedOwnerOrSystemUser(target)) {
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText: `محظور: الحساب ${target.displayName} (@${target.username}) محمي ولا يمكن حذفه.`,
        toolSteps: [{ toolName: 'delete_user_account', labelAr: 'حذف مستخدم', status: 'error', summaryAr: 'حساب محمي.' }],
      });
    }
    const deleted = await deleteRegularUserByAssistant(target.id);
    await appendAuditLog({
      actionType: 'delete_user_account',
      command: cleanInput,
      target: `@${deleted.username} (#${deleted.id})`,
      status: 'success',
      details: `تم حذف حساب المستخدم ${deleted.displayName} (@${deleted.username}) مباشرة عبر الخادم.`,
    });
    return finalizeDirectReply({
      cleanInput,
      turnStartedAt,
      thread,
      replyText: `تم حذف حساب المستخدم ${deleted.displayName} (@${deleted.username} #${deleted.id}) من النظام بنجاح.`,
      toolSteps: [{ toolName: 'delete_user_account', labelAr: 'حذف مستخدم', status: 'ok', summaryAr: `@${deleted.username}` }],
    });
  }

  // F. Direct List Channels (0 Gemini calls)
  if (/^(?:(?:اعرض|عرض|هات|اظهر|ما هي|اعطني)\s+)?(?:كل\s+|جميع\s+|قائمه\s+|اسماء\s+)*?(?:القنوات|قنوات التطبيق)(?:\s+المتاحه)?[!؟.]*$/.test(norm) || /^القنوات المتاحه[!؟.]*$/.test(norm)) {
    const chs = await getChannelsForUser(OWNER_ID, 'owner');
    const lines = chs.map(
      (c, idx) =>
        `${idx + 1}. «${c.name}» (${c.id}) — ${c.isOpenPublic ? 'مفتوحة للجميع' : c.visibility === 'hidden' ? 'مخفية' : 'مغلقة بكلمة مرور'} | الأعضاء: ${
          c.displayMemberCount ?? (c.memberIds?.length || c.allowedMemberIds?.length || 1)
        }`
    );
    return finalizeDirectReply({
      cleanInput,
      turnStartedAt,
      thread,
      replyText: chs.length === 0 ? 'لا توجد قنوات حالياً.' : `القنوات المتاحة في التطبيق (${chs.length}):\n\n${lines.join('\n')}`,
      toolSteps: [{ toolName: 'list_channels', labelAr: 'استعراض القنوات', status: 'ok', summaryAr: `تم جلب ${chs.length} قناة.` }],
    });
  }

  // G. Direct Audit Logs (0 Gemini calls)
  if (/^(?:اعرض|عرض|هات)?\s*(?:سجل العمليات|سجل التدقيق|اخر العمليات)[!؟.]*$/.test(norm)) {
    const logs = (store.auditLogs || []).slice(0, 12);
    const replyText =
      logs.length === 0
        ? 'لا توجد عمليات مسجلة في سجل التدقيق حتى الآن.'
        : `آخر ${logs.length} عمليات مسجلة:\n\n${logs
            .map((l) => `• [${l.status}] ${l.actionType} — ${l.target}\n  ${l.details}`)
            .join('\n')}`;
    return finalizeDirectReply({
      cleanInput,
      turnStartedAt,
      thread,
      replyText,
      toolSteps: [{ toolName: 'get_audit_logs', labelAr: 'قراءة سجل التدقيق', status: 'ok', summaryAr: `عرض ${logs.length} سجل.` }],
    });
  }

  // H. Direct Single-Intent Navigation (0 Gemini calls)
  const navMatch = norm.match(/^(?:توجه|اذهب|انتقل|افتح|ادخل|روح)\s+(?:(?:الي|علي|ل)\s+)?(.+)$/);
  const hasSecondaryAction = /(?:وانشئ|واكتب|واقرا|وارسل|وحضر|وجهز|تفاعل|تفاعلات|حساب|مستخدم)/.test(norm);
  if (navMatch && !hasSecondaryAction) {
    const targetPhrase = navMatch[1].trim();
    const matchedSection = mapArabicSectionTarget(targetPhrase);
    const matchedChannel =
      matchedSection && matchedSection !== 'channels' ? null : await resolveChannelTarget(targetPhrase, thread);
    if (matchedChannel || matchedSection) {
      const nav: AiNavigationDirective = matchedChannel
        ? { tab: 'channels', channelId: matchedChannel.id, channelName: matchedChannel.name }
        : { tab: matchedSection! };
      thread = await updateThreadContext({
        activeSection: nav.tab,
        activeChannelId: matchedChannel ? matchedChannel.id : thread.activeChannelId,
        activeChannelName: matchedChannel ? matchedChannel.name : thread.activeChannelName,
      });
      await appendAuditLog({
        actionType: 'navigate_app',
        command: cleanInput,
        target: matchedChannel ? `${matchedChannel.name} (${matchedChannel.id})` : nav.tab,
        status: 'success',
        details: `تم التوجيه مباشرة إلى ${matchedChannel ? `قناة ${matchedChannel.name}` : nav.tab}.`,
      });
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        navigation: nav,
        replyText: matchedChannel
          ? `تم تحديث السياق النشط وتوجيهك إلى قناة «${matchedChannel.name}».`
          : `تم توجيهك إلى قسم «${nav.tab}».`,
        toolSteps: [
          {
            toolName: 'navigate_app',
            labelAr: matchedChannel ? `التوجه إلى «${matchedChannel.name}»` : `الانتقال إلى ${nav.tab}`,
            status: 'ok',
            summaryAr: matchedChannel ? `القناة النشطة: ${matchedChannel.name}` : `القسم: ${nav.tab}`,
          },
        ],
      });
    }
  }

  // I. Direct Read Channel Messages (0 Gemini calls)
  const readMsgsMatch = norm.match(
    /^(?:اقرا|اعرض|اجلب|جلب|هات)\s+(?:اخر\s+)?(?:(\d+)\s+)?(?:رسائل|رساله|الرسائل)(?:\s+(?:في|من|داخل)\s+(.+))?$/
  );
  if (readMsgsMatch && !/(?:وانشئ|تفاعل|تفاعلات)/.test(norm)) {
    const limit = Math.max(1, Math.min(50, Number(readMsgsMatch[1]) || 10));
    const chQuery = readMsgsMatch[2]?.trim() || null;
    const ch = await resolveChannelTarget(chQuery, thread);
    if (ch) {
      const msgs = await getChannelMessages(ch.id, limit);
      thread = await updateThreadContext({ activeChannelId: ch.id, activeChannelName: ch.name });
      await appendAuditLog({
        actionType: 'read_channel_messages',
        command: cleanInput,
        target: `${ch.name} (${ch.id})`,
        status: 'success',
        details: `قراءة آخر ${msgs.length} رسائل مباشرة.`,
      });
      const lines = msgs.map(
        (m, idx) =>
          `${idx + 1}. ${m.senderName}: ${
            m.text || (m.imageUrl ? '[صورة]' : m.audioUrl ? '[رسالة صوتية]' : '[مرفق]')
          }`
      );
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        replyText:
          msgs.length === 0
            ? `لا توجد رسائل حالياً في قناة «${ch.name}».`
            : `آخر ${msgs.length} رسائل في قناة «${ch.name}»:\n\n${lines.join('\n')}`,
        toolSteps: [
          {
            toolName: 'read_channel_messages',
            labelAr: `قراءة رسائل «${ch.name}»`,
            status: 'ok',
            summaryAr: `تمت قراءة ${msgs.length} رسالة.`,
          },
        ],
      });
    }
  }

  // J. Direct Route for Yemeni-dialect channel discussion setup (presents Two Options first!)
  const parsedReq = await parsePersonaDiscussionRequest(asciiInput, norm);
  if (parsedReq) {
    let ch = await resolveChannelTarget(parsedReq.channelQuery || (!thread.activeChannelId ? 'القناة العامة' : null), thread);
    if (!ch && parsedReq.channelQuery) {
      ch = await resolveChannelTarget('القناة العامة', thread);
    }
    if (!ch) {
      const allChs = await getChannelsForUser(OWNER_ID, 'owner');
      ch = allChs[0] || null;
    }
    if (ch) {
      const recentMsgs = await getChannelMessages(ch.id, 10);
      const sampleTexts = recentMsgs.map((m) => m.text).filter((x): x is string => Boolean(x));
      const effectiveTopic =
        parsedReq.topic.length >= 2
          ? parsedReq.topic
          : sampleTexts.length > 0
          ? `التفاعل مع آخر تطورات قناة ${ch.name}`
          : 'تفاعل إيجابي حول صفقات القناة';

      const promptRes = await createInteractionAccountChoicePrompt({
        channel: ch,
        count: parsedReq.count,
        topic: effectiveTopic,
        intervalSeconds: parsedReq.intervalSeconds,
        commandText: cleanInput,
      });

      if (parsedReq.explicitAccountMode) {
        try {
          const resolved = await resolveInteractionAccountsChoice(promptRes.action.id, {
            mode: parsedReq.explicitAccountMode,
            commandContext: cleanInput,
            fromChatFlow: true,
          });
          thread = ensureThread();
          return finalizeDirectReply({
            cleanInput,
            turnStartedAt,
            thread,
            draftId: resolved.draft.id,
            navigation: resolved.navigation,
            createdAccounts: resolved.createdAccounts,
            replyText: resolved.replyText,
            toolSteps: [
              ...(resolved.createdAccounts.length > 0
                ? [
                    {
                      toolName: 'create_user_accounts',
                      labelAr: `إنشاء ${resolved.createdAccounts.length} حسابات (user)`,
                      status: 'ok' as const,
                      summaryAr: `تم تسجيل ${resolved.createdAccounts.length} حساب فعلي.`,
                    },
                  ]
                : []),
              {
                toolName: 'prepare_virtual_persona_interactions',
                labelAr: `توليد ${resolved.draft.items.length} تفاعلات باللهجة اليمنية`,
                status: 'pending_confirmation',
                summaryAr: `جاهزة للمراجعة لقناة «${ch.name}».`,
              },
            ],
          });
        } catch {
          // Fall back cleanly to presenting the two choices if explicit mode failed (e.g. 0 existing accounts)
        }
      }

      thread = ensureThread();
      return finalizeDirectReply({
        cleanInput,
        turnStartedAt,
        thread,
        pendingActionId: promptRes.action.id,
        navigation: { tab: 'channels', channelId: ch.id, channelName: ch.name },
        replyText: promptRes.replyText,
        toolSteps: [
          {
            toolName: 'choose_interaction_accounts',
            labelAr: `اختيار حسابات لـ ${parsedReq.count} مشاركين`,
            status: 'pending_confirmation',
            summaryAr: `قناة «${ch.name}» — اختر إنشاء حسابات جديدة أو من الحالية (${promptRes.existingCount} متاح).`,
          },
        ],
      });
    }
  }

  return null;
}

function buildPartialToolSummaryAr(opts: {
  toolSteps: AiToolStep[];
  createdDraftId: string | null;
  createdPendingActionId: string | null;
  navigationDirective: AiNavigationDirective | null;
  createdAccountsBatch: CreatedUserCredential[];
}): string {
  const lines: string[] = [];
  if (opts.navigationDirective?.channelName) {
    lines.push(`تم تحديث السياق والانتقال إلى قناة «${opts.navigationDirective.channelName}».`);
  }
  if (opts.createdDraftId) {
    lines.push('تم تجهيز مسودة التفاعلات وعرضها للمراجعة والاعتماد.');
  }
  if (opts.createdPendingActionId) {
    lines.push('تم تجهيز الإجراء الإداري المعلق بانتظار تأكيدك.');
  }
  if (opts.createdAccountsBatch.length > 0) {
    lines.push(`تم إنشاء ${opts.createdAccountsBatch.length} حساب مستخدم بصلاحية user وعرض بياناتها.`);
  }
  if (lines.length === 0 && opts.toolSteps.length > 0) {
    return opts.toolSteps.map((s) => `• ${s.labelAr}: ${s.summaryAr}`).join('\n');
  }
  return lines.join('\n') || 'تم تنفيذ الخطوات المطلوبة بنجاح.';
}

async function executeInternalFallbackNlu(params: {
  cleanInput: string;
  turnStartedAt: number;
  existingUserMessage?: AiAssistantMessage;
}): Promise<{
  userMessage: AiAssistantMessage;
  assistantMessage: AiAssistantMessage;
  thread: AiAssistantThread;
  activeDraft: AiAssistantDraft | null;
  activePendingAction: AiAssistantPendingAction | null;
  createdAccounts?: CreatedUserCredential[];
}> {
  const store = getAiAssistantDiskStore();
  let thread = ensureThread();
  const prePending = getLatestPending(params.turnStartedAt);
  const ascii = toAsciiDigits(params.cleanInput).trim();
  const norm = normalizeArabicForMatch(ascii);

  const userMessage =
    params.existingUserMessage ||
    (await appendChatMessage({
      role: 'user',
      text: params.cleanInput,
      timestamp: params.turnStartedAt,
    }));

  const toolSteps: AiToolStep[] = [];
  let createdDraftId: string | null = null;
  let createdPendingActionId: string | null = null;
  let navigationDirective: AiNavigationDirective | null = null;
  let replyText = '';

  const finishFallback = async () => {
    const assistantMessage = await appendChatMessage({
      role: 'assistant',
      text: replyText,
      toolSteps: toolSteps.length > 0 ? toolSteps : null,
      draftId: createdDraftId,
      pendingActionId: createdPendingActionId,
      navigation: navigationDirective,
      timestamp: Date.now(),
    });
    const activeDraft = createdDraftId ? (store.drafts?.[createdDraftId] as AiAssistantDraft) || null : null;
    const activePendingAction = createdPendingActionId
      ? (store.pendingActions?.[createdPendingActionId] as AiAssistantPendingAction) || null
      : null;
    return {
      userMessage,
      assistantMessage,
      thread,
      activeDraft,
      activePendingAction,
    };
  };

  // 1. Contextual follow-up approval / cancellation for open draft or pending action
  if (prePending.draft || prePending.action) {
    const wantsCancel = /(?:الغ|الغي|إلغاء|الغاء|ارفض|رفض|اوقف|توقف|لا تنشر)/.test(norm) && norm.split(/\s+/).length <= 10;
    const wantsApprove =
      !wantsCancel &&
      /(?:اعتمد|موافق|نعم|انشر|ابدا النشر|نفذ|تاكيد|اكد|تمام|ممتاز)/.test(norm) &&
      norm.split(/\s+/).length <= 10;

    if (wantsCancel && prePending.draft) {
      const cancelled = await cancelDraft(prePending.draft.id);
      replyText = `تم إلغاء مسودة التفاعلات (${cancelled.items.length} تفاعلات) لقناة «${cancelled.channelName}».`;
      toolSteps.push({ toolName: 'confirm_pending', labelAr: 'إلغاء المسودة', status: 'ok', summaryAr: 'تم الإلغاء.' });
      return finishFallback();
    }
    if (wantsApprove && prePending.draft) {
      const intervalOverride = parseIntervalSecondsFromArabic(ascii);
      const res = await approveAndPublishDraft(prePending.draft.id, params.cleanInput, intervalOverride);
      navigationDirective = {
        tab: 'channels',
        channelId: res.draft.channelId,
        channelName: res.draft.channelName,
        messageId: res.publishedMessages[res.publishedMessages.length - 1]?.id || null,
      };
      const usedInt = res.draft.intervalSeconds || 0;
      replyText = res.scheduled
        ? `تم اعتماد المسودة وبدء النشر المجدول في قناة «${res.draft.channelName}» كل ${usedInt} ثانية.`
        : `تم اعتماد ونشر ${res.publishedMessages.length} تفاعلات في قناة «${res.draft.channelName}».`;
      toolSteps.push({
        toolName: 'confirm_pending',
        labelAr: res.scheduled ? 'بدء النشر المجدول' : 'نشر المسودة',
        status: 'ok',
        summaryAr: replyText,
      });
      return finishFallback();
    }
    if (wantsCancel && prePending.action) {
      const cancelled = await cancelPendingAction(prePending.action.id);
      replyText = `تم إلغاء الإجراء المعلق: ${cancelled.titleAr}.`;
      toolSteps.push({ toolName: 'confirm_pending', labelAr: 'إلغاء الإجراء', status: 'ok', summaryAr: cancelled.titleAr });
      return finishFallback();
    }
    if (wantsApprove && prePending.action && prePending.action.actionType !== 'choose_interaction_accounts') {
      const res = await confirmPendingAction(prePending.action.id, params.cleanInput);
      if (res.navigation) navigationDirective = res.navigation;
      replyText = res.action.resultMessage || `تم تنفيذ الإجراء: ${res.action.titleAr}.`;
      toolSteps.push({ toolName: 'confirm_pending', labelAr: res.action.titleAr, status: 'ok', summaryAr: replyText });
      return finishFallback();
    }
  }

  // 2. Persona discussion setup -> always show Two Options prompt first
  const parsedFallbackReq = await parsePersonaDiscussionRequest(ascii, norm);
  const wantsPersonas = Boolean(parsedFallbackReq) || /(?:تفاعل|تفاعلات|تفاعلين|شخصي|شخصيه|شخصيات|شخصيتين|حوار|حوارات|ردود|تعليقات|اضف رد|زيد رد|يتكلم|يتحدث|يطلب|تتطلب|تطلب)/.test(norm);
  if (wantsPersonas) {
    let channelQuery: string | null = parsedFallbackReq?.channelQuery || null;
    if (!channelQuery) {
      const chMention = ascii.match(/(?:في|الى|إلى|لقناة|لقناه|بقناة|بقناه|قناة|قناه)\s+([a-zA-Z0-9_\u0600-\u06FF-]+(?:\s+[a-zA-Z0-9_\u0600-\u06FF-]+)?)/i);
      if (chMention) {
        const cand = chMention[1].replace(/^(?:قناه|قناة)\s+/i, '').trim();
        if (!/^(?:النشطه|الحاليه|نفسها|هذه|معينه|محدده)$/.test(normalizeArabicForMatch(cand))) {
          channelQuery = cand;
        }
      }
    }
    let ch = await resolveChannelTarget(channelQuery || (!thread.activeChannelId ? 'القناة العامة' : null), thread);
    if (!ch) ch = await resolveChannelTarget('القناة العامة', thread);
    if (ch) {
      const count = parsedFallbackReq?.count ?? (parsePersonaInteractionCount(ascii) ?? (prePending.draft && /(?:اضف|زيد)/.test(norm) ? 2 : 3));
      const intervalSeconds = parsedFallbackReq?.intervalSeconds ?? clampIntervalSeconds(parseIntervalSecondsFromArabic(ascii) ?? 0);
      const topicExtract = ascii.match(/(?:حول|عن|بخصوص|على|بشأن|بشان)\s+(.+)$/i);
      const cleanTopic = parsedFallbackReq?.topic && parsedFallbackReq.topic.length >= 2
        ? parsedFallbackReq.topic
        : (topicExtract ? topicExtract[1] : ascii)
            .replace(/(?:في|داخل)\s+(?:قناه|قناة)\s+.+$/i, '')
            .replace(/كل\s*\d+\s*(?:ثانيه|ثانية|ثواني|دقيقه|دقيقة|دقائق).*$/i, '')
            .replace(/^(?:موضوع)\s+/i, '')
            .trim();
      const effectiveTopic = cleanTopic || prePending.draft?.topic || `التفاعل مع موضوع قناة ${ch.name}`;

      const promptRes = await createInteractionAccountChoicePrompt({
        channel: ch,
        count,
        topic: effectiveTopic,
        intervalSeconds,
        commandText: params.cleanInput,
      });

      createdPendingActionId = promptRes.action.id;
      navigationDirective = { tab: 'channels', channelId: ch.id, channelName: ch.name };
      thread = ensureThread();

      toolSteps.push({
        toolName: 'choose_interaction_accounts',
        labelAr: `اختيار حسابات لـ ${count} مشاركين`,
        status: 'pending_confirmation',
        summaryAr: `قناة «${ch.name}» — اختر إنشاء حسابات جديدة أو من الحالية (${promptRes.existingCount} متاح).`,
      });

      replyText = promptRes.replyText;
      return finishFallback();
    }
  }

  // 3. Challenge & trades inspection
  if (/(?:تحدي|صفقات|رصيد|محطه|محطات|الارباح|الأرباح)/.test(norm)) {
    const ownerUser = await getUserById(OWNER_ID);
    const challenge = await getUserChallenge(OWNER_ID, ownerUser?.displayName || 'القائد Salim');
    const trades = await getUserTrades(OWNER_ID);
    const recent = trades.slice(-5);
    toolSteps.push({
      toolName: 'read_user_challenge_and_trades',
      labelAr: `قراءة تحدي وصفقات ${ownerUser?.displayName || 'Salim'}`,
      status: 'ok',
      summaryAr: `${trades.length} صفقة، الرصيد ${(challenge.currentBalanceCents / 100).toFixed(2)}$`,
    });
    const tradeLines =
      recent.length > 0
        ? recent.map((t: any, idx: number) => `${idx + 1}. ${t.symbol || t.pair || 'صفقة'} — ${(Number(t.profitCents || 0) / 100).toFixed(2)}$`).join('\n')
        : 'لا توجد صفقات مسجلة حالياً.';
    replyText = `بيانات التحدي الحالية لـ ${ownerUser?.displayName || 'القائد Salim'}:\n• الرصيد الحالي: $${(challenge.currentBalanceCents / 100).toFixed(2)}\n• رأس المال المبدئي: $${(challenge.initialCapitalCents / 100).toFixed(2)}\n• الهدف: $${(challenge.targetBalanceCents / 100).toFixed(2)}\n• إجمالي الصفقات: ${trades.length}\n\nآخر الصفقات:\n${tradeLines}`;
    return finishFallback();
  }

  // 4. Propose channel message if explicitly asked to send/post a message into a channel
  const proposeMsgMatch = ascii.match(/(?:ارسل|انشر|اكتب)\s+(?:رساله|رسالة|اعلان|إعلان)\s+(?:في|الى|إلى)\s+(?:قناه|قناة)?\s*([^\s:]+)\s*[:：\-]\s*(.+)$/i);
  if (proposeMsgMatch) {
    const ch = await resolveChannelTarget(proposeMsgMatch[1].trim(), thread);
    const msgText = sanitizeNoBannedAiDisclaimer(proposeMsgMatch[2].trim());
    if (ch && msgText) {
      const now = Date.now();
      const action: AiAssistantPendingAction = {
        id: makeId('aiact'),
        ownerId: OWNER_ID,
        ownerUsername: OWNER_USERNAME,
        actionType: 'send_channel_message',
        titleAr: `إرسال رسالة إلى قناة «${ch.name}»`,
        summaryAr: `سيتم نشر الرسالة التالية باسم القائد Salim في «${ch.name}»:\n"${msgText}"`,
        payload: { channelId: ch.id, channelName: ch.name, text: msgText },
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      store.pendingActions![action.id] = action;
      saveAiAssistantDiskStore();
      await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
      createdPendingActionId = action.id;
      thread = await updateThreadContext({ activeChannelId: ch.id, activeChannelName: ch.name });
      toolSteps.push({
        toolName: 'propose_channel_message',
        labelAr: action.titleAr,
        status: 'pending_confirmation',
        summaryAr: 'بانتظار موافقة المالك.',
      });
      replyText = `جهّزت الرسالة للنشر في قناة «${ch.name}» بانتظار تأكيدك ("اعتمد" أو عبر زر التأكيد).`;
      return finishFallback();
    }
  }

  // 5. Contextual conversational fallback preserving active context & previous turns (never returns 429 or stall)
  const chs = await getChannelsForUser(OWNER_ID, 'owner');
  const activeCtx = thread.activeChannelName
    ? `القناة النشطة حالياً في سياقنا: «${thread.activeChannelName}».`
    : `توجد ${chs.length} قناة متاحة في التطبيق.`;
  replyText = [
    `تم استلام طلبك ومتابعة السياق (${activeCtx}).`,
    'أستطيع تنفيذه مباشرة الآن — يمكنك مثلاً صياغة الطلب بوضوح مثل:',
    '• «توجه إلى قناة salim1 وجهّز تفاعلات لثلاث شخصيات حول صفقة حققت ربحًا قدره 30 دولارًا»',
    '• «أنشئ 3 حسابات مستخدمين بأسماء يمنية»',
    '• «اقرأ آخر 10 رسائل في القناة العامة» أو «اعرض قائمة المستخدمين»',
    ...(prePending.draft ? ['• أو الرد بـ «اعتمد» لنشر مسودة التفاعلات المعلقة الحالية.'] : []),
  ].join('\n');
  return finishFallback();
}

export async function processOwnerAiChat(userText: string): Promise<{
  userMessage: AiAssistantMessage;
  assistantMessage: AiAssistantMessage;
  thread: AiAssistantThread;
  activeDraft: AiAssistantDraft | null;
  activePendingAction: AiAssistantPendingAction | null;
  createdAccounts?: CreatedUserCredential[];
}> {
  const cleanInput = String(userText || '').trim();
  if (!cleanInput) {
    throw new Error('الرسالة فارغة.');
  }

  const turnStartedAt = Date.now();

  // 1. Try direct server execution first (user/account/navigation/reading ops = 0 Gemini calls;
  // virtual persona interactions automatically fail over inside generateDiverseVirtualPersonasWithEngine)
  const directRes = await tryExecuteDirectArabicCommand(cleanInput, turnStartedAt);
  if (directRes) {
    return {
      userMessage: directRes.userMessage,
      assistantMessage: directRes.assistantMessage,
      thread: directRes.thread,
      activeDraft: directRes.activeDraft,
      activePendingAction: directRes.activePendingAction,
      ...(directRes.createdAccounts ? { createdAccounts: directRes.createdAccounts } : {}),
    };
  }

  // 2. If Gemini is currently in cooldown or unavailable, execute seamlessly via Internal Fallback NLU
  if (!isGeminiAvailableNow()) {
    return executeInternalFallbackNlu({
      cleanInput,
      turnStartedAt,
    });
  }

  // 3. Gemini tool-calling flow (with instant automatic failover on 429 / quota / connectivity loss)
  const userMessage = await appendChatMessage({
    role: 'user',
    text: cleanInput,
    timestamp: turnStartedAt,
  });

  const store = getAiAssistantDiskStore();
  let thread = ensureThread();

  const historyMsgs = (store.messages || []).slice(-22, -1);
  const prePending = getLatestPending(turnStartedAt);

  const contents: Content[] = historyMsgs.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.text }],
  }));
  contents.push({
    role: 'user',
    parts: [{ text: cleanInput }],
  });

  const toolSteps: AiToolStep[] = [];
  let createdDraftId: string | null = null;
  let createdPendingActionId: string | null = null;
  let navigationDirective: AiNavigationDirective | null = null;
  let createdAccountsBatch: CreatedUserCredential[] = [];

  let finalText = '';
  const MAX_TOOL_ROUNDS = 6;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await invokeGeminiGenerate({
        model: GEMINI_MODEL,
        contents,
        config: {
          systemInstruction: buildSystemInstruction(thread, prePending.draft, prePending.action),
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        },
      });

    const fnCalls = response.functionCalls;
    const candidateContent = response.candidates?.[0]?.content;

    if (!fnCalls || fnCalls.length === 0) {
      finalText = sanitizeNoBannedAiDisclaimer(response.text || '');
      break;
    }

    if (candidateContent) {
      contents.push(candidateContent);
    }

    const fnResponseParts: any[] = [];

    for (const call of fnCalls) {
      const name = String(call.name || '');
      const args = (call.args || {}) as Record<string, any>;
      let toolResult: Record<string, any> = {};

      try {
        if (name === 'list_channels') {
          const chs = await getChannelsForUser(OWNER_ID, 'owner');
          const summary = chs.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
            visibility: c.visibility,
            isOpenPublic: Boolean(c.isOpenPublic || (!c.isPrivate && !c.password)),
            memberCount: c.displayMemberCount ?? (c.memberIds?.length || c.allowedMemberIds?.length || 1),
          }));
          toolSteps.push({
            toolName: name,
            labelAr: 'استعراض القنوات',
            status: 'ok',
            summaryAr: `تم جلب ${summary.length} قناة.`,
          });
          toolResult = { channels: summary };
        } else if (name === 'navigate_app') {
          const validSections = ['dashboard', 'channels', 'private_chat', 'admin', 'history', 'roadmap', 'settings', 'ai_assistant'];
          const section = validSections.includes(String(args.section)) ? String(args.section) : 'channels';
          let targetChannel: ChannelRecord | null = null;
          let targetPartner: { id: number; username: string; displayName: string; role: string } | null = null;

          if (args.channelQuery) {
            targetChannel = await resolveChannelTarget(String(args.channelQuery), thread);
          } else if (section === 'channels') {
            targetChannel = await resolveChannelTarget(null, thread);
          }

          if (args.partnerQuery) {
            targetPartner = await resolveUserTarget(String(args.partnerQuery));
          }

          const nav: AiNavigationDirective = {
            tab: (targetChannel ? 'channels' : targetPartner ? 'private_chat' : section) as AiNavigationDirective['tab'],
            channelId: targetChannel?.id || null,
            channelName: targetChannel?.name || null,
            partnerId: targetPartner?.id || null,
            partnerName: targetPartner?.displayName || null,
          };
          navigationDirective = nav;
          thread = await updateThreadContext({
            activeSection: nav.tab,
            activeChannelId: targetChannel ? targetChannel.id : thread.activeChannelId,
            activeChannelName: targetChannel ? targetChannel.name : thread.activeChannelName,
            activePartnerId: targetPartner ? targetPartner.id : thread.activePartnerId,
          });
          await appendAuditLog({
            actionType: 'navigate_app',
            command: cleanInput,
            target: targetChannel ? `${targetChannel.name} (${targetChannel.id})` : nav.tab,
            status: 'success',
            details: `تم تحديث السياق والانتقال إلى ${targetChannel ? `قناة ${targetChannel.name}` : nav.tab}.`,
          });
          toolSteps.push({
            toolName: name,
            labelAr: targetChannel ? `التوجه إلى «${targetChannel.name}»` : `الانتقال إلى ${nav.tab}`,
            status: 'ok',
            summaryAr: targetChannel ? `القناة النشطة الآن: ${targetChannel.name}` : `القسم النشط: ${nav.tab}`,
          });
          toolResult = { navigated: true, navigation: nav };
        } else if (name === 'read_channel_messages') {
          const ch = await resolveChannelTarget(args.channelQuery, thread);
          if (!ch) {
            toolSteps.push({
              toolName: name,
              labelAr: 'قراءة رسائل القناة',
              status: 'error',
              summaryAr: 'لم يتم تحديد قناة صالحة.',
            });
            toolResult = { error: 'لم يتم العثور على القناة المطلوبة. حدد اسم القناة أو استعرض القنوات أولاً.' };
          } else {
            const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
            const msgs = await getChannelMessages(ch.id, limit);
            thread = await updateThreadContext({ activeChannelId: ch.id, activeChannelName: ch.name });
            const items = msgs.map((m) => ({
              id: m.id,
              senderId: m.senderId,
              senderName: m.senderName,
              senderRole: m.senderRole === 'virtual_persona' ? 'user' : m.senderRole,
              text: m.text || (m.imageUrl ? '[صورة]' : m.audioUrl ? '[رسالة صوتية]' : m.fileName ? `[ملف: ${m.fileName}]` : ''),
              timestamp: m.timestamp,
              isPinned: Boolean(m.isPinned),
            }));
            await appendAuditLog({
              actionType: 'read_channel_messages',
              command: cleanInput,
              target: `${ch.name} (${ch.id})`,
              status: 'success',
              details: `قراءة آخر ${items.length} رسائل في القناة.`,
            });
            toolSteps.push({
              toolName: name,
              labelAr: `قراءة رسائل «${ch.name}»`,
              status: 'ok',
              summaryAr: `تمت قراءة ${items.length} رسالة.`,
            });
            toolResult = { channelId: ch.id, channelName: ch.name, messages: items };
          }
        } else if (name === 'list_users') {
          const all = await getAllUsersList();
          const q = args.search ? normalizeArabicForMatch(String(args.search)) : '';
          const filtered = q
            ? all.filter(
                (u) =>
                  normalizeArabicForMatch(u.username).includes(q) ||
                  normalizeArabicForMatch(u.displayName).includes(q)
              )
            : all;
          const list = filtered.slice(0, 60).map((u) => ({
            id: u.id,
            username: u.username,
            displayName: u.displayName,
            role: u.role,
            isRestrictedAdmin: Boolean(u.isRestrictedAdmin),
          }));
          toolSteps.push({
            toolName: name,
            labelAr: 'جلب قائمة المستخدمين',
            status: 'ok',
            summaryAr: `تم العثور على ${list.length} مستخدم.`,
          });
          toolResult = { total: filtered.length, users: list };
        } else if (name === 'read_user_challenge_and_trades') {
          const u = args.userQuery ? await resolveUserTarget(String(args.userQuery)) : await getUserById(OWNER_ID);
          if (!u) {
            toolResult = { error: 'المستخدم غير موجود.' };
          } else {
            const challenge = await getUserChallenge(u.id, u.displayName);
            const trades = await getUserTrades(u.id);
            toolSteps.push({
              toolName: name,
              labelAr: `قراءة تحدي وصفقات ${u.displayName}`,
              status: 'ok',
              summaryAr: `${trades.length} صفقة، الرصيد ${(challenge.currentBalanceCents / 100).toFixed(2)}$`,
            });
            toolResult = {
              user: { id: u.id, username: u.username, displayName: u.displayName },
              challenge: {
                initialCapitalUsd: challenge.initialCapitalCents / 100,
                currentBalanceUsd: challenge.currentBalanceCents / 100,
                targetBalanceUsd: challenge.targetBalanceCents / 100,
                tradeCount: challenge.tradeCount,
                started: challenge.challengeStarted,
              },
              recentTrades: trades.slice(-15),
            };
          }
        } else if (name === 'prepare_virtual_persona_interactions') {
          let ch = await resolveChannelTarget(args.channelQuery || 'القناة العامة', thread);
          if (!ch) ch = await resolveChannelTarget('القناة العامة', thread);
          if (!ch) {
            toolSteps.push({
              toolName: name,
              labelAr: 'إعداد تفاعلات الأعضاء',
              status: 'error',
              summaryAr: 'لم يتم العثور على القناة المستهدفة.',
            });
            toolResult = { error: 'لم يتم العثور على القناة المستهدفة.' };
          } else {
            const count = Math.max(1, Math.min(30, Math.floor(Number(args.count) || 5)));
            const intervalSeconds = clampIntervalSeconds(args.intervalSeconds);
            const topic = String(args.topic || 'تفاعل إيجابي حول الصفقة').trim();
            const reqMode = String(args.accountMode || 'ask').toLowerCase();

            const promptRes = await createInteractionAccountChoicePrompt({
              channel: ch,
              count,
              topic,
              intervalSeconds,
              commandText: cleanInput,
            });
            thread = ensureThread();

            if (reqMode === 'create_new' || reqMode === 'select_existing') {
              const resolved = await resolveInteractionAccountsChoice(promptRes.action.id, {
                mode: reqMode,
                commandContext: cleanInput,
                fromChatFlow: true,
              });
              createdDraftId = resolved.draft.id;
              navigationDirective = resolved.navigation;
              if (resolved.createdAccounts.length > 0) {
                createdAccountsBatch = [...createdAccountsBatch, ...resolved.createdAccounts];
              }
              toolSteps.push({
                toolName: name,
                labelAr: `توليد ${resolved.draft.items.length} تفاعلات باللهجة اليمنية`,
                status: 'pending_confirmation',
                summaryAr: `جاهزة للمراجعة لقناة «${ch.name}».`,
              });
              toolResult = {
                status: 'pending_approval',
                draftId: resolved.draft.id,
                channelId: ch.id,
                channelName: ch.name,
                topic,
                intervalSeconds,
                count: resolved.draft.items.length,
                createdAccountsCount: resolved.createdAccounts.length,
                items: resolved.draft.items.map((it, idx) => ({
                  index: idx + 1,
                  personaName: it.personaName,
                  dialect: it.dialect,
                  text: it.text,
                })),
              };
            } else {
              createdPendingActionId = promptRes.action.id;
              navigationDirective = { tab: 'channels', channelId: ch.id, channelName: ch.name };
              toolSteps.push({
                toolName: 'choose_interaction_accounts',
                labelAr: `اختيار حسابات لـ ${count} مشاركين`,
                status: 'pending_confirmation',
                summaryAr: `خياران بانتظار المالك (${promptRes.existingCount} حساب حالي متاح).`,
              });
              toolResult = {
                status: 'awaiting_account_mode_choice',
                actionId: promptRes.action.id,
                channelId: ch.id,
                channelName: ch.name,
                count,
                topic,
                existingAccountsCount: promptRes.existingCount,
                options: [
                  { mode: 'create_new', labelAr: `إنشاء ${count} حسابات جديدة` },
                  { mode: 'select_existing', labelAr: `اختيار من الحسابات الحالية (${promptRes.existingCount})` },
                ],
              };
            }
          }
        } else if (name === 'resolve_interaction_accounts') {
          const targetAction = prePending.action?.actionType === 'choose_interaction_accounts' ? prePending.action : null;
          if (!targetAction) {
            toolResult = { error: 'لا يوجد طلب معلق بانتظار اختيار الحسابات حالياً.' };
          } else {
            const mode = String(args.mode || 'create_new') === 'select_existing' ? 'select_existing' : 'create_new';
            const selectedIds = Array.isArray(args.selectedUserIds)
              ? args.selectedUserIds.map((x: unknown) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0)
              : undefined;
            const resolved = await resolveInteractionAccountsChoice(targetAction.id, {
              mode,
              selectedUserIds: selectedIds,
              commandContext: cleanInput,
              fromChatFlow: true,
            });
            createdDraftId = resolved.draft.id;
            navigationDirective = resolved.navigation;
            if (resolved.createdAccounts.length > 0) {
              createdAccountsBatch = [...createdAccountsBatch, ...resolved.createdAccounts];
            }
            toolSteps.push({
              toolName: name,
              labelAr: `توليد ${resolved.draft.items.length} تفاعلات باللهجة اليمنية`,
              status: 'pending_confirmation',
              summaryAr: `جاهزة للمراجعة لقناة «${resolved.draft.channelName}».`,
            });
            toolResult = {
              status: 'pending_approval',
              draftId: resolved.draft.id,
              channelId: resolved.draft.channelId,
              channelName: resolved.draft.channelName,
              count: resolved.draft.items.length,
              createdAccountsCount: resolved.createdAccounts.length,
              items: resolved.draft.items.map((it, idx) => ({
                index: idx + 1,
                personaName: it.personaName,
                dialect: it.dialect,
                text: it.text,
              })),
            };
          }
        } else if (name === 'confirm_pending') {
          const decision = String(args.decision || 'approve').toLowerCase();
          const targetId = args.targetId ? String(args.targetId) : '';
          const targetDraft =
            (targetId ? store.drafts?.[targetId] : null) || prePending.draft;
          const targetAction =
            (targetId ? store.pendingActions?.[targetId] : null) || prePending.action;

          if (targetDraft && targetDraft.status === 'pending_approval' && targetDraft.createdAt < turnStartedAt) {
            if (decision === 'cancel') {
              const cancelled = await cancelDraft(targetDraft.id);
              toolSteps.push({
                toolName: name,
                labelAr: 'إلغاء مسودة التفاعلات',
                status: 'ok',
                summaryAr: `تم إلغاء المسودة (${cancelled.items.length} تفاعلات).`,
              });
              toolResult = { cancelled: true, draftId: cancelled.id };
            } else {
              const intervalOverride =
                args.intervalSeconds !== undefined ? clampIntervalSeconds(args.intervalSeconds) : undefined;
              const res = await approveAndPublishDraft(targetDraft.id, cleanInput, intervalOverride);
              navigationDirective = {
                tab: 'channels',
                channelId: res.draft.channelId,
                channelName: res.draft.channelName,
                messageId: res.publishedMessages[res.publishedMessages.length - 1]?.id || null,
              };
              const usedInterval = res.draft.intervalSeconds || 0;
              toolSteps.push({
                toolName: name,
                labelAr: res.scheduled
                  ? `بدء النشر المجدول (${res.draft.items.length})`
                  : `نشر ${res.publishedMessages.length} تفاعلات`,
                status: 'ok',
                summaryAr: res.scheduled
                  ? `تم إرسال الأولى في «${res.draft.channelName}» وتُرسل البقية كل ${usedInterval} ثانية.`
                  : `تم النشر في «${res.draft.channelName}».`,
              });
              toolResult = {
                published: !res.scheduled,
                scheduled: res.scheduled,
                intervalSeconds: usedInterval,
                draftId: res.draft.id,
                channelId: res.draft.channelId,
                channelName: res.draft.channelName,
                totalCount: res.draft.items.length,
                publishedCount: res.publishedMessages.length,
              };
            }
          } else if (targetAction && targetAction.status === 'pending' && targetAction.createdAt < turnStartedAt) {
            if (decision === 'cancel') {
              const cancelled = await cancelPendingAction(targetAction.id);
              toolSteps.push({
                toolName: name,
                labelAr: 'إلغاء الإجراء المعلق',
                status: 'ok',
                summaryAr: cancelled.titleAr,
              });
              toolResult = { cancelled: true, actionId: cancelled.id };
            } else {
              const res = await confirmPendingAction(targetAction.id, cleanInput);
              if (res.navigation) navigationDirective = res.navigation;
              toolSteps.push({
                toolName: name,
                labelAr: res.action.titleAr,
                status: 'ok',
                summaryAr: res.action.resultMessage || 'تم التنفيذ.',
              });
              toolResult = { executed: true, actionId: res.action.id, resultMessage: res.action.resultMessage };
            }
          } else {
            toolResult = {
              error: 'لا توجد مسودة أو إجراء معلق من رسالة سابقة لتأكيده. يجب عرض المسودة للمالك أولاً ثم تأكيدها في رسالة تالية أو عبر زر الاعتماد.',
            };
          }
        } else if (name === 'propose_channel_message') {
          const ch = await resolveChannelTarget(args.channelQuery, thread);
          if (!ch) {
            toolResult = { error: 'لم يتم تحديد قناة صالحة.' };
          } else {
            const now = Date.now();
            const text = sanitizeNoBannedAiDisclaimer(String(args.text || ''));
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'send_channel_message',
              titleAr: `إرسال رسالة إلى قناة «${ch.name}»`,
              summaryAr: `سيتم نشر الرسالة التالية باسم القائد Salim في «${ch.name}»:\n"${text}"`,
              payload: { channelId: ch.id, channelName: ch.name, text },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            thread = await updateThreadContext({ activeChannelId: ch.id, activeChannelName: ch.name });
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: `${ch.name} (${ch.id})`,
              status: 'pending',
              details: `بانتظار تأكيد المالك لإرسال رسالة قناة.`,
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_private_message') {
          const u = await resolveUserTarget(String(args.userQuery || ''));
          if (!u) {
            toolResult = { error: 'لم يتم العثور على المستخدم المستهدف.' };
          } else {
            const now = Date.now();
            const text = sanitizeNoBannedAiDisclaimer(String(args.text || ''));
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'send_private_message',
              titleAr: `إرسال رسالة خاصة إلى ${u.displayName}`,
              summaryAr: `سيتم إرسال رسالة خاصة من القائد Salim إلى ${u.displayName} (@${u.username}):\n"${text}"`,
              payload: { receiverId: u.id, receiverUsername: u.username, receiverDisplayName: u.displayName, text },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: `${u.username} (#${u.id})`,
              status: 'pending',
              details: 'بانتظار تأكيد المالك لإرسال رسالة خاصة.',
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_create_channel') {
          const now = Date.now();
          const chName = String(args.name || '').trim();
          if (!chName) {
            toolResult = { error: 'اسم القناة مطلوب.' };
          } else {
            const visibility = args.visibility === 'hidden' ? 'hidden' : 'visible';
            const isOpenPublic = visibility !== 'hidden' && Boolean(args.isOpenPublic);
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'create_channel',
              titleAr: `إنشاء قناة جديدة: «${chName}»`,
              summaryAr: `النوع: ${isOpenPublic ? 'مفتوحة للعامة' : visibility === 'hidden' ? 'مخفية للأعضاء فقط' : 'مغلقة بكلمة مرور'}`,
              payload: {
                name: chName,
                description: String(args.description || '').trim(),
                visibility,
                isOpenPublic,
                password: isOpenPublic ? '' : String(args.password || '').trim(),
              },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: chName,
              status: 'pending',
              details: 'بانتظار تأكيد المالك لإنشاء قناة.',
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_update_channel') {
          const ch = await resolveChannelTarget(args.channelQuery, thread);
          if (!ch) {
            toolResult = { error: 'القناة غير موجودة.' };
          } else {
            const now = Date.now();
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'update_channel',
              titleAr: `تحديث إعدادات قناة «${ch.name}»`,
              summaryAr: `سيتم تعديل إعدادات القناة «${ch.name}» وفق التغييرات المطلوبة.`,
              payload: {
                channelId: ch.id,
                channelName: ch.name,
                name: args.name,
                description: args.description,
                isOpenPublic: args.isOpenPublic,
                visibility: args.visibility,
                password: args.password,
              },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: `${ch.name} (${ch.id})`,
              status: 'pending',
              details: 'بانتظار تأكيد المالك لتعديل القناة.',
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_delete_channel') {
          const ch = await resolveChannelTarget(args.channelQuery, thread);
          if (!ch) {
            toolResult = { error: 'القناة غير موجودة.' };
          } else {
            const now = Date.now();
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'delete_channel',
              titleAr: `حذف قناة «${ch.name}»`,
              summaryAr: `تحذير: سيتم حذف القناة «${ch.name}» (${ch.id}) نهائياً.`,
              payload: { channelId: ch.id, channelName: ch.name },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: `${ch.name} (${ch.id})`,
              status: 'pending',
              details: 'بانتظار تأكيد المالك لحذف القناة.',
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'إجراء حساس بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_manage_channel_members') {
          const ch = await resolveChannelTarget(args.channelQuery, thread);
          const u = await resolveUserTarget(String(args.userQuery || ''));
          if (!ch || !u) {
            toolResult = { error: !ch ? 'القناة غير موجودة.' : 'المستخدم غير موجود.' };
          } else {
            const op = args.operation === 'remove' ? 'remove' : 'add';
            const now = Date.now();
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'manage_channel_members',
              titleAr: op === 'remove' ? `إزالة ${u.displayName} من «${ch.name}»` : `إضافة ${u.displayName} إلى «${ch.name}»`,
              summaryAr:
                op === 'remove'
                  ? `سيتم سحب صلاحية وصول ${u.displayName} (@${u.username}) لقناة «${ch.name}».`
                  : `سيتم إضافة ${u.displayName} (@${u.username}) لقائمة الأعضاء المصرح لهم في قناة «${ch.name}».`,
              payload: {
                operation: op,
                channelId: ch.id,
                channelName: ch.name,
                userId: u.id,
                userDisplayName: u.displayName,
              },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: `${ch.name} / ${u.username}`,
              status: 'pending',
              details: 'بانتظار تأكيد المالك لتعديل أعضاء القناة.',
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_manage_user') {
          const u = await resolveUserTarget(String(args.userQuery || ''));
          if (!u) {
            toolResult = { error: 'المستخدم غير موجود.' };
          } else if (u.id === OWNER_ID) {
            toolResult = { error: 'لا يمكن تغيير دور أو حذف حساب المالك الرئيسي.' };
          } else {
            const op = args.operation === 'delete_user' ? 'delete_user' : 'set_role';
            const nextRole = args.role === 'moderator' ? 'moderator' : 'user';
            const now = Date.now();
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'manage_user',
              titleAr:
                op === 'delete_user'
                  ? `حذف حساب ${u.displayName}`
                  : `تعيين ${u.displayName} كـ ${nextRole === 'moderator' ? 'مشرف' : 'عضو'}`,
              summaryAr:
                op === 'delete_user'
                  ? `تحذير: سيتم حذف المستخدم ${u.displayName} (@${u.username}) نهائياً.`
                  : `سيتم تغيير رتبة ${u.displayName} (@${u.username}) إلى ${nextRole === 'moderator' ? 'مشرف' : 'عضو'}.`,
              payload: {
                operation: op,
                userId: u.id,
                userDisplayName: u.displayName,
                role: nextRole,
              },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: `${u.username} (#${u.id})`,
              status: 'pending',
              details: 'بانتظار تأكيد المالك لإدارة المستخدم.',
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_pin_channel_message') {
          const ch = await resolveChannelTarget(args.channelQuery, thread);
          if (!ch) {
            toolResult = { error: 'لم يتم العثور على القناة.' };
          } else {
            const now = Date.now();
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'pin_channel_message',
              titleAr: `تبديل تثبيت رسالة في «${ch.name}»`,
              summaryAr: `سيتم تثبيت أو إلغاء تثبيت الرسالة (${args.messageId}) في «${ch.name}».`,
              payload: { channelId: ch.id, channelName: ch.name, messageId: String(args.messageId) },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'create_user_accounts') {
          const cnt = Math.max(1, Math.min(30, Math.floor(Number(args.count) || 1)));
          const customDisplayNames = Array.isArray(args.customDisplayNames)
            ? args.customDisplayNames.map((x: unknown) => String(x || '').trim()).filter(Boolean)
            : undefined;
          const customPassword = args.customPassword ? String(args.customPassword).trim() : undefined;
          const { created, failed } = await createUsersBatchViaAssistant({
            count: cnt,
            customDisplayNames,
            customPassword,
          });
          if (created.length > 0) {
            createdAccountsBatch = [...createdAccountsBatch, ...created];
            navigationDirective = { tab: 'admin' };
            await appendAuditLog({
              actionType: 'create_user_accounts',
              command: cleanInput,
              target: created.map((u) => `@${u.username} (#${u.id})`).join(', '),
              status: 'success',
              details: `تم إنشاء ${created.length} حساب مستخدم بصلاحية user عبر أداة المساعد.`,
            });
            toolSteps.push({
              toolName: name,
              labelAr: `إنشاء ${created.length} حسابات (user)`,
              status: 'ok',
              summaryAr: `تم تسجيل ${created.length} حساب فعلي في النظام.`,
            });
          } else {
            toolSteps.push({
              toolName: name,
              labelAr: 'إنشاء حسابات مستخدمين',
              status: 'error',
              summaryAr: failed[0]?.error || 'فشل الإنشاء.',
            });
          }
          toolResult = { createdCount: created.length, accounts: created, failed };
        } else if (name === 'update_user_account') {
          const target = await resolveUserTarget(String(args.userQuery || ''));
          if (!target) {
            toolResult = { error: 'المستخدم غير موجود.' };
          } else {
            const updated = await updateRegularUserByAssistant({
              userId: target.id,
              ...(args.displayName !== undefined ? { displayName: String(args.displayName) } : {}),
              ...(args.password !== undefined ? { password: String(args.password) } : {}),
              ...(args.generateRandomPassword ? { generateRandomPassword: true } : {}),
              ...(args.warningsCount !== undefined ? { warningsCount: Number(args.warningsCount) } : {}),
            });
            await appendAuditLog({
              actionType: 'update_user_account',
              command: cleanInput,
              target: `@${updated.username} (#${updated.id})`,
              status: 'success',
              details: 'تم تحديث بيانات الحساب مباشرة.',
            });
            toolSteps.push({
              toolName: name,
              labelAr: `تحديث حساب @${updated.username}`,
              status: 'ok',
              summaryAr: updated.displayName,
            });
            toolResult = { updated };
          }
        } else if (name === 'delete_user_account') {
          const target = await resolveUserTarget(String(args.userQuery || ''));
          if (!target) {
            toolResult = { error: 'المستخدم غير موجود.' };
          } else {
            const deleted = await deleteRegularUserByAssistant(target.id);
            await appendAuditLog({
              actionType: 'delete_user_account',
              command: cleanInput,
              target: `@${deleted.username} (#${deleted.id})`,
              status: 'success',
              details: `تم حذف حساب المستخدم ${deleted.displayName}.`,
            });
            toolSteps.push({
              toolName: name,
              labelAr: `حذف حساب @${deleted.username}`,
              status: 'ok',
              summaryAr: deleted.displayName,
            });
            toolResult = { deleted };
          }
        } else if (name === 'get_audit_logs') {
          const lim = Math.max(1, Math.min(30, Number(args.limit) || 15));
          const logs = (store.auditLogs || []).slice(0, lim);
          toolSteps.push({
            toolName: name,
            labelAr: 'قراءة سجل التدقيق',
            status: 'ok',
            summaryAr: `عرض ${logs.length} سجل.`,
          });
          toolResult = { logs };
        } else {
          toolResult = { error: `أداة غير معروفة: ${name}` };
        }
      } catch (toolErr: any) {
        if (toolErr instanceof GeminiRateLimitError || toolErr instanceof GeminiConfigError) {
          throw toolErr;
        }
        toolSteps.push({
          toolName: name,
          labelAr: name,
          status: 'error',
          summaryAr: toolErr?.message || 'خطأ غير متوقع',
        });
        toolResult = { error: toolErr?.message || 'فشل تنفيذ الأداة.' };
      }

      fnResponseParts.push({
        functionResponse: {
          id: call.id,
          name,
          response: toolResult,
        },
      });
    }

    contents.push({
      role: 'user',
      parts: fnResponseParts,
    });
    }
  } catch (loopErr: any) {
    // Any Gemini 429 / quota / config / connectivity failure fails over cleanly without losing context or executed steps
    if (loopErr instanceof GeminiFallbackSignalError || classifyGeminiError(loopErr).isRateLimit || classifyGeminiError(loopErr).isAuthOrKey) {
      if (toolSteps.length === 0) {
        return executeInternalFallbackNlu({
          cleanInput,
          turnStartedAt,
          existingUserMessage: userMessage,
        });
      }
      finalText = buildPartialToolSummaryAr({
        toolSteps,
        createdDraftId,
        createdPendingActionId,
        navigationDirective,
        createdAccountsBatch,
      });
    } else {
      if (toolSteps.length === 0) {
        return executeInternalFallbackNlu({
          cleanInput,
          turnStartedAt,
          existingUserMessage: userMessage,
        });
      }
      finalText = buildPartialToolSummaryAr({
        toolSteps,
        createdDraftId,
        createdPendingActionId,
        navigationDirective,
        createdAccountsBatch,
      });
    }
  }

  if (!finalText) {
    finalText = buildPartialToolSummaryAr({
      toolSteps,
      createdDraftId,
      createdPendingActionId,
      navigationDirective,
      createdAccountsBatch,
    });
  }

  const assistantMessage = await appendChatMessage({
    role: 'assistant',
    text: finalText,
    toolSteps: toolSteps.length > 0 ? toolSteps : null,
    draftId: createdDraftId,
    pendingActionId: createdPendingActionId,
    navigation: navigationDirective,
    createdAccounts: createdAccountsBatch.length > 0 ? createdAccountsBatch : null,
    timestamp: Date.now(),
  });

  const activeDraft = createdDraftId ? (store.drafts?.[createdDraftId] as AiAssistantDraft) || null : null;
  const activePendingAction = createdPendingActionId
    ? (store.pendingActions?.[createdPendingActionId] as AiAssistantPendingAction) || null
    : null;

  return {
    userMessage,
    assistantMessage,
    thread,
    activeDraft,
    activePendingAction,
    ...(createdAccountsBatch.length > 0 ? { createdAccounts: createdAccountsBatch } : {}),
  };
}
