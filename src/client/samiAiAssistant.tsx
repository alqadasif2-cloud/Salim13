import React, { useState, useEffect, useRef, useCallback } from './samiReactShim.ts';

interface CurrentUser {
  id: number;
  username: string;
  displayName?: string;
  role: string;
  token?: string;
  isRestrictedAdmin?: boolean;
}

interface ToolStep {
  toolName: string;
  labelAr: string;
  status: 'ok' | 'pending_confirmation' | 'error';
  summaryAr: string;
}

interface NavDirective {
  tab: 'dashboard' | 'channels' | 'private_chat' | 'admin' | 'history' | 'roadmap' | 'settings' | 'ai_assistant';
  channelId?: string | null;
  channelName?: string | null;
  partnerId?: number | null;
  partnerName?: string | null;
  messageId?: string | null;
}

interface CreatedUserCredential {
  id: number;
  displayName: string;
  username: string;
  password: string;
  role: string;
  createdAt?: number;
}

interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolSteps?: ToolStep[] | null;
  draftId?: string | null;
  pendingActionId?: string | null;
  navigation?: NavDirective | null;
  createdAccounts?: CreatedUserCredential[] | null;
  timestamp: number;
}

interface PersonaDraftItem {
  id: string;
  userId?: number;
  username?: string;
  avatarUrl?: string | null;
  personaName: string;
  dialect: string;
  styleTag: string;
  text: string;
}

interface AiDraft {
  id: string;
  channelId: string;
  channelName: string;
  topic: string;
  status: 'pending_approval' | 'publishing' | 'published' | 'cancelled';
  items: PersonaDraftItem[];
  intervalSeconds?: number;
  nextPublishAt?: number | null;
  publishedCount?: number;
  createdAt: number;
  updatedAt: number;
}

interface ExistingAccountOption {
  id: number;
  username: string;
  displayName: string;
  role: string;
  avatarUrl?: string | null;
}

interface PendingAction {
  id: string;
  actionType: string;
  titleAr: string;
  summaryAr: string;
  payload?: {
    channelId?: string;
    channelName?: string;
    count?: number;
    topic?: string;
    intervalSeconds?: number;
    existingAccounts?: ExistingAccountOption[];
    [key: string]: any;
  };
  status: 'pending' | 'executed' | 'cancelled';
  resultMessage?: string | null;
  createdAt: number;
}

interface AuditLog {
  id: string;
  actionType: string;
  command: string;
  target: string;
  status: 'success' | 'pending' | 'cancelled' | 'error';
  details: string;
  timestamp: number;
}

interface ThreadState {
  activeSection?: string | null;
  activeChannelId?: string | null;
  activeChannelName?: string | null;
  activePartnerId?: number | null;
}

interface Props {
  currentUser: CurrentUser | null;
  onNavigate?: (nav: NavDirective) => void;
  onToast?: (msg: string) => void;
}

function isMainOwnerSalim(user: CurrentUser | null | undefined): boolean {
  if (!user) return false;
  if (Number(user.id) !== 1) return false;
  if (user.isRestrictedAdmin) return false;
  if (String(user.role || '').toLowerCase() !== 'owner') return false;
  return String(user.username || '').trim().toLowerCase() === 'salim';
}

const DEFAULT_AI_SERVER_BASE = 'https://ais-pre-ljvmb2ezkv67qiojp5xgpk-877998647748.europe-west2.run.app';

function isAndroidLocalOrigin(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      (window.location.hostname === 'appassets.androidplatform.net' || window.location.protocol === 'file:')
    );
  } catch {
    return false;
  }
}

function sanitizeRemoteBase(raw: string | null | undefined): string {
  const s = String(raw || '').trim();
  if (!s || s === 'MY_APP_URL') return '';
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== 'https:') return '';
    const h = parsed.hostname.toLowerCase();
    if (
      !h ||
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '0.0.0.0' ||
      h === 'appassets.androidplatform.net' ||
      h.startsWith('ais-dev-') ||
      h.includes('wrwn7qrad4ng4e3ejalosp') ||
      h.includes('puwra2x2ecorh5lpokb4yk') ||
      h.endsWith('.usercontent.goog')
    ) {
      return '';
    }
    return parsed.origin.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function getApiBase(): string {
  try {
    if (!isAndroidLocalOrigin()) {
      return '';
    }
    const w = window as any;
    if (typeof w.getSamiServerBaseUrl === 'function') {
      const b = String(w.getSamiServerBaseUrl() || '').trim();
      const clean = sanitizeRemoteBase(b);
      if (clean) return clean;
    }
    const winBase = sanitizeRemoteBase(w.__samiConfiguredServerBase);
    if (winBase) return winBase;
    try {
      const rawStored = localStorage.getItem('sami_push_server_url');
      const stored = sanitizeRemoteBase(rawStored);
      if (stored) return stored;
      if (rawStored) localStorage.removeItem('sami_push_server_url');
    } catch {}
    if (w.SamiBridge && typeof w.SamiBridge.getRemoteServerUrl === 'function') {
      const nativeBase = sanitizeRemoteBase(w.SamiBridge.getRemoteServerUrl());
      if (nativeBase) return nativeBase;
    }
  } catch {}
  return isAndroidLocalOrigin() ? DEFAULT_AI_SERVER_BASE : '';
}

function formatAiNetworkError(err: any, endpointUrl: string): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'لا يوجد اتصال بالإنترنت على الجهاز حالياً. تحقق من الواي فاي أو بيانات الهاتف ثم أعد المحاولة.';
  }
  const name = String(err?.name || '');
  const rawMsg = String(err?.message || '').trim();
  const lower = rawMsg.toLowerCase();

  const targetHost = (() => {
    try {
      return new URL(endpointUrl, typeof window !== 'undefined' ? window.location.origin : DEFAULT_AI_SERVER_BASE).host;
    } catch {
      return 'الخادم البعيد';
    }
  })();

  if (name === 'AbortError' || lower.includes('aborted') || lower.includes('timeout')) {
    return 'انتهت مهلة الاتصال بخادم المساعد الذكي قبل وصول الرد. قد يكون الاتصال بطيئاً أو الطلب طويلاً — اضغط «إعادة المحاولة».';
  }
  if (
    lower === 'failed to fetch' ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('load failed') ||
    lower.includes('network request failed') ||
    lower.includes('err_connection') ||
    lower.includes('err_name_not_resolved')
  ) {
    return `تعذر الوصول إلى خادم المساعد الذكي (${targetHost}). قد يكون الخادم غير منشور على هذا العنوان أو الشبكة تمنع الوصول — اضغط «فحص الاتصال» للتحقق.`;
  }
  if (rawMsg) {
    return rawMsg;
  }
  return 'حدث خطأ غير متوقع أثناء الاتصال بالمساعد الذكي.';
}

function readStoredJwt(): string {
  try {
    const raw = localStorage.getItem('sami_auth_user_session');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.token && typeof parsed.token === 'string') {
        return parsed.token;
      }
    }
  } catch {}
  return '';
}

function buildSamiSessionHeader(user: CurrentUser | null | undefined): string {
  try {
    let src: any = user;
    if (!src || !src.id) {
      const raw = localStorage.getItem('sami_auth_user_session');
      if (raw) src = JSON.parse(raw);
    }
    if (src && src.id) {
      return encodeURIComponent(
        JSON.stringify({
          id: Number(src.id),
          username: String(src.username || ''),
          displayName: String(src.displayName || src.username || ''),
          role: String(src.role || 'user'),
          isGuest: false,
          isRestrictedAdmin: Boolean(src.isRestrictedAdmin || Number(src.id) === 76 || Number(src.id) === 77),
        })
      );
    }
  } catch {}
  return '';
}

function formatTimeAr(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch {
    return '';
  }
}

const QUICK_COMMANDS = [
  'أريد 10 شخصيات يتكلمون عن إدارة رأس المال في القناة العامة',
  'أنشئ 3 حسابات مستخدمين بأسماء يمنية',
  'اعرض قائمة المستخدمين',
  'اعرض كل القنوات المتاحة',
  'توجّه إلى القناة العامة',
  'اقرأ آخر 10 رسائل في القناة العامة',
];

function formatNavigationLabelAr(nav: NavDirective): string {
  if (nav.channelName) return nav.channelName;
  if (nav.partnerName) return nav.partnerName;
  const map: Record<string, string> = {
    admin: 'لوحة الإدارة',
    channels: 'القنوات',
    dashboard: 'الرئيسية',
    private_chat: 'المحادثات الخاصة',
    history: 'السجل',
    roadmap: 'خريطة الطريق',
    settings: 'الإعدادات',
    ai_assistant: 'المساعد الذكي',
  };
  return map[nav.tab] || nav.tab;
}

export function SamiAiAssistantPanel({ currentUser, onNavigate, onToast }: Props) {
  const allowed = isMainOwnerSalim(currentUser);

  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [thread, setThread] = useState<ThreadState>({});
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [drafts, setDrafts] = useState<AiDraft[]>([]);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  const [inputText, setInputText] = useState('');
  const [showAuditModal, setShowAuditModal] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [draftEdits, setDraftEdits] = useState<Record<string, PersonaDraftItem[]>>({});
  const [draftIntervals, setDraftIntervals] = useState<Record<string, number>>({});
  const [busyDraftId, setBusyDraftId] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, boolean>>({});
  const [expandedExistingPicker, setExpandedExistingPicker] = useState<Record<string, boolean>>({});
  const [selectedExistingIds, setSelectedExistingIds] = useState<Record<string, number[]>>({});
  const [existingSearchQuery, setExistingSearchQuery] = useState<Record<string, string>>({});

  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  const copyTextToClipboard = useCallback(async (text: string, toastLabel: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        onToast?.(toastLabel);
        return;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      onToast?.(toastLabel);
    } catch {
      onToast?.('تعذر النسخ إلى الحافظة.');
    }
  }, [onToast]);

  const exportAccountsCsv = useCallback((accounts: CreatedUserCredential[]) => {
    const esc = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['ID', 'DisplayName', 'Username', 'Password', 'Role'].join(',');
    const rows = accounts.map((a) => [esc(a.id), esc(a.displayName), esc(a.username), esc(a.password), esc(a.role)].join(','));
    const csv = '\uFEFF' + [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `salim_users_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    onToast?.(`تم تصدير ${accounts.length} حسابات إلى ملف CSV.`);
  }, [onToast]);

  const [checkingConn, setCheckingConn] = useState(false);

  const callAiApi = useCallback(async (path: string, options: RequestInit = {}, timeoutMs = 20000) => {
    const token = currentUser?.token || readStoredJwt();
    const sessionHeader = buildSamiSessionHeader(currentUser);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    };
    if (sessionHeader) {
      headers['x-sami-session'] = sessionHeader;
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const method = String(options.method || 'GET').toUpperCase();
    const maxAttempts = method === 'GET' ? 2 : 1;

    let lastErr: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const base = getApiBase();
      const targetUrl = `${base}/api/ai-assistant${path}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);

      try {
        let res = await fetch(targetUrl, {
          ...options,
          headers,
          cache: 'no-store',
          signal: ctrl.signal,
        });

        // If an old/stale Bearer JWT failed 401, retry cleanly using x-sami-session
        if (res.status === 401 && headers['Authorization'] && headers['x-sami-session']) {
          const fallbackHeaders = { ...headers };
          delete fallbackHeaders['Authorization'];
          res = await fetch(targetUrl, {
            ...options,
            headers: fallbackHeaders,
            cache: 'no-store',
            signal: ctrl.signal,
          });
        }
        clearTimeout(timer);

        const contentType = String(res.headers.get('content-type') || '').toLowerCase();
        const rawText = await res.text();
        let data: any = {};
        if (rawText) {
          try {
            data = JSON.parse(rawText);
          } catch {
            if (rawText.trim().startsWith('<') || contentType.includes('text/html')) {
              const hostName = (() => {
                try {
                  return new URL(targetUrl, window.location.origin).host;
                } catch {
                  return 'الخادم البعيد';
                }
              })();
              if (res.status === 404) {
                throw new Error(
                  `عنوان خادم المساعد الذكي (${hostName}) أعاد خطأ 404 (الخدمة غير منشورة أو رابط الإنتاج غير مفعّل بعد). يجب مشاركة/نشر الخادم أولاً ثم إعادة المحاولة.`
                );
              }
              if (res.status === 401 || res.status === 403) {
                throw new Error(
                  `خادم المساعد الذكي (${hostName}) يرفض الوصول الخارجي (رمز ${res.status}). تأكد من أن رابط الخادم عام وليس رابط معاينة محمياً.`
                );
              }
              throw new Error(
                `الخادم (${hostName}) أعاد صفحة HTML بدلاً من JSON (رمز ${res.status}). تأكد من أن عنوان الخادم المعتمد متاح.`
              );
            }
          }
        }

        if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 700));
          continue;
        }

        if (!res.ok) {
          throw new Error(data?.error || `تعذر إكمال الطلب من الخادم (رمز ${res.status}).`);
        }

        return data;
      } catch (err: any) {
        clearTimeout(timer);
        lastErr = err;

        const isNetworkFailure =
          err?.name === 'TypeError' ||
          err?.name === 'AbortError' ||
          String(err?.message || '').toLowerCase().includes('fetch');

        if (isNetworkFailure && attempt < maxAttempts) {
          try {
            const w = window as any;
            if (typeof w.discoverSamiCloudStateFromFirestore === 'function') {
              await w.discoverSamiCloudStateFromFirestore();
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }

        throw new Error(formatAiNetworkError(err, targetUrl));
      }
    }

    throw new Error(formatAiNetworkError(lastErr, `${getApiBase()}/api/ai-assistant${path}`));
  }, [currentUser]);

  const loadState = useCallback(async (silent = false) => {
    if (!allowed) {
      if (!silent) setLoading(false);
      return;
    }
    if (!silent) {
      setLoading(true);
      setErrorMsg(null);
    }
    try {
      const data = await callAiApi('/state', { method: 'GET' }, 15000);
      setThread(data.thread || {});
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      setDrafts(Array.isArray(data.drafts) ? data.drafts : []);
      setPendingActions(Array.isArray(data.pendingActions) ? data.pendingActions : []);
      setAuditLogs(Array.isArray(data.auditLogs) ? data.auditLogs : []);
    } catch (err: any) {
      if (!silent) setErrorMsg(formatAiNetworkError(err, `${getApiBase()}/api/ai-assistant/state`));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [allowed, callAiApi]);

  const handleCheckConnection = useCallback(async () => {
    setCheckingConn(true);
    const targetUrl = `${getApiBase()}/api/health`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(targetUrl, { method: 'GET', cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      const ctype = String(res.headers.get('content-type') || '').toLowerCase();
      const rawText = await res.text().catch(() => '');
      let data: any = {};
      try {
        if (rawText) data = JSON.parse(rawText);
      } catch {}
      if (res.ok && data?.ok) {
        setErrorMsg(null);
        onToast?.('الاتصال بالخادم سليم ونشط — جارٍ تحديث المساعد الذكي...');
        await loadState(false);
      } else if (res.status === 404 && (ctype.includes('text/html') || rawText.trim().startsWith('<'))) {
        setErrorMsg(`عنوان الخادم البعيد غير منشور بعد (404 HTML على ${targetUrl}). يرجى نشر/مشاركة الخادم السحابي في Google AI Studio.`);
      } else {
        setErrorMsg(`الخادم استجاب برمز (${res.status}) أثناء فحص الاتصال (${targetUrl}).`);
      }
    } catch (err: any) {
      clearTimeout(timer);
      setErrorMsg(formatAiNetworkError(err, targetUrl));
    } finally {
      setCheckingConn(false);
    }
  }, [loadState, onToast]);

  useEffect(() => {
    loadState(false);
  }, [loadState]);

  const hasPublishingDraft = drafts.some((d) => d.status === 'publishing');

  useEffect(() => {
    if (!hasPublishingDraft) return;
    const pollId = setInterval(() => {
      void loadState(true);
    }, 3000);
    const tickId = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, [hasPublishingDraft, loadState]);

  useEffect(() => {
    try {
      scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    } catch {}
  }, [messages.length, drafts.length, pendingActions.length]);

  const handleSend = async (customPrompt?: string) => {
    const text = (customPrompt !== undefined ? customPrompt : inputText).trim();
    if (!text || sending || !allowed) return;
    if (customPrompt === undefined) setInputText('');
    setSending(true);
    setErrorMsg(null);

    const optimisticUserMsg: AiMessage = {
      id: `local_${Date.now()}`,
      role: 'user',
      text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);

    try {
      const data = await callAiApi(
        '/chat',
        {
          method: 'POST',
          body: JSON.stringify({ message: text }),
        },
        45000
      );
      await loadState();
      if (data?.assistantMessage?.navigation && onNavigate) {
        const nav = data.assistantMessage.navigation as NavDirective;
        if (nav.tab && nav.tab !== 'ai_assistant') {
          onToast?.(`جاهز للانتقال إلى: ${nav.channelName || nav.tab}`);
        }
      }
    } catch (err: any) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticUserMsg.id));
      if (customPrompt === undefined) setInputText(text);
      setErrorMsg(formatAiNetworkError(err, `${getApiBase()}/api/ai-assistant/chat`));
    } finally {
      setSending(false);
    }
  };

  const getDraftItems = (draft: AiDraft): PersonaDraftItem[] => {
    return draftEdits[draft.id] || draft.items || [];
  };

  const getDraftInterval = (draft: AiDraft): number => {
    if (draftIntervals[draft.id] !== undefined) {
      return Math.max(0, Math.min(3600, Math.round(Number(draftIntervals[draft.id]) || 0)));
    }
    return Math.max(0, Math.min(3600, Math.round(Number(draft.intervalSeconds) || 0)));
  };

  const handleApproveDraft = async (draft: AiDraft) => {
    setBusyDraftId(draft.id);
    setErrorMsg(null);
    const intervalSeconds = getDraftInterval(draft);
    try {
      if (draftEdits[draft.id]) {
        await callAiApi(`/drafts/${encodeURIComponent(draft.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ items: draftEdits[draft.id], intervalSeconds }),
        });
      }
      const res = await callAiApi(`/drafts/${encodeURIComponent(draft.id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ intervalSeconds }),
      });
      setEditingDraftId(null);
      onToast?.(res.message || 'تم نشر التفاعلات بنجاح.');
      await loadState(true);
    } catch (err: any) {
      setErrorMsg(err?.message || 'فشل نشر التفاعلات.');
    } finally {
      setBusyDraftId(null);
    }
  };

  const handleCancelDraft = async (draftId: string) => {
    setBusyDraftId(draftId);
    setErrorMsg(null);
    try {
      await callAiApi(`/drafts/${encodeURIComponent(draftId)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setEditingDraftId(null);
      onToast?.('تم إلغاء المسودة.');
      await loadState();
    } catch (err: any) {
      setErrorMsg(err?.message || 'فشل إلغاء المسودة.');
    } finally {
      setBusyDraftId(null);
    }
  };

  const handleConfirmAction = async (actionId: string) => {
    setBusyActionId(actionId);
    setErrorMsg(null);
    try {
      const res = await callAiApi(`/actions/${encodeURIComponent(actionId)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      onToast?.(res?.action?.resultMessage || 'تم تنفيذ الإجراء بنجاح.');
      await loadState();
      if (res?.navigation && onNavigate && res.navigation.tab !== 'ai_assistant') {
        onNavigate(res.navigation);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'فشل تنفيذ الإجراء.');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleCancelAction = async (actionId: string) => {
    setBusyActionId(actionId);
    setErrorMsg(null);
    try {
      await callAiApi(`/actions/${encodeURIComponent(actionId)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      onToast?.('تم إلغاء الإجراء المعلق.');
      await loadState();
    } catch (err: any) {
      setErrorMsg(err?.message || 'فشل إلغاء الإجراء.');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleResolveAccountChoice = async (
    actionId: string,
    mode: 'create_new' | 'select_existing',
    userIds?: number[]
  ) => {
    setBusyActionId(actionId);
    setErrorMsg(null);
    try {
      const res = await callAiApi(`/actions/${encodeURIComponent(actionId)}/resolve-accounts`, {
        method: 'POST',
        body: JSON.stringify({
          mode,
          ...(userIds && userIds.length > 0 ? { selectedUserIds: userIds } : {}),
        }),
      });
      setExpandedExistingPicker((prev) => ({ ...prev, [actionId]: false }));
      onToast?.(
        mode === 'create_new'
          ? `تم إنشاء ${res?.createdAccounts?.length || 0} حسابات وتوليد المواضيع باللهجة اليمنية.`
          : 'تم توليد المواضيع باللهجة اليمنية للحسابات المختارة.'
      );
      await loadState();
    } catch (err: any) {
      setErrorMsg(err?.message || 'تعذر تنفيذ الاختيار المطلوب.');
    } finally {
      setBusyActionId(null);
    }
  };

  const handleResetChat = async () => {
    setConfirmReset(false);
    try {
      await callAiApi('/reset', { method: 'POST', body: JSON.stringify({}) });
      onToast?.('تم بدء محادثة جديدة مع المساعد الذكي.');
      await loadState();
    } catch (err: any) {
      setErrorMsg(err?.message || 'تعذر إعادة ضبط المحادثة.');
    }
  };

  if (!allowed) {
    return (
      <div dir="rtl" className="max-w-xl mx-auto my-10 p-6 rounded-2xl bg-[#0d1424] border border-red-500/30 text-center">
        <p className="text-red-300 font-bold text-sm">هذا القسم مخصص حصرياً لحساب المالك الرئيسي (Salim).</p>
      </div>
    );
  }

  const openDrafts = drafts.filter((d) => d.status === 'pending_approval');
  const publishingDrafts = drafts.filter((d) => d.status === 'publishing');
  const openActions = pendingActions.filter((a) => a.status === 'pending');

  return (
    <div dir="rtl" className="max-w-4xl mx-auto w-full px-3 sm:px-5 pt-4 pb-6 flex flex-col gap-3">
      {/* Header Bar */}
      <div className="rounded-2xl bg-gradient-to-br from-[#0e1628] via-[#0b1220] to-[#171206] border border-amber-500/30 p-4 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 text-slate-950 flex items-center justify-center font-black text-xl shadow-lg shadow-amber-500/20">
              ✦
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-black text-white">المساعد الذكي</h1>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-400/40">
                  خاص بالمالك Salim
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                مساعد تنفيذي وإداري خاص يفهم أوامرك بالعربية وينفذها مباشرة في الخادم.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAuditModal((v) => !v)}
              className="px-3 py-1.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold cursor-pointer transition-colors"
            >
              {showAuditModal ? 'العودة للمحادثة' : `سجل العمليات (${auditLogs.length})`}
            </button>
            {!confirmReset ? (
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-amber-300 border border-amber-500/30 text-xs font-bold cursor-pointer transition-colors"
              >
                محادثة جديدة
              </button>
            ) : (
              <div className="flex items-center gap-1.5 bg-red-950/60 border border-red-500/40 rounded-xl px-2 py-1">
                <span className="text-[11px] text-red-200 font-bold">مسح السجل؟</span>
                <button
                  type="button"
                  onClick={handleResetChat}
                  className="px-2 py-0.5 rounded-lg bg-red-600 text-white text-[11px] font-bold cursor-pointer"
                >
                  نعم
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmReset(false)}
                  className="px-2 py-0.5 rounded-lg bg-slate-700 text-slate-200 text-[11px] font-bold cursor-pointer"
                >
                  لا
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Active Context Strip */}
        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-2 text-slate-300">
            <span className="text-slate-500">السياق النشط:</span>
            <span className="px-2 py-0.5 rounded-lg bg-slate-900 border border-slate-700 text-amber-300 font-bold">
              {thread.activeChannelName ? `القناة: ${thread.activeChannelName}` : `القسم: ${thread.activeSection || 'المساعد الذكي'}`}
            </span>
          </div>
          {thread.activeChannelId && onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate({ tab: 'channels', channelId: thread.activeChannelId, channelName: thread.activeChannelName })}
              className="text-amber-400 hover:text-amber-300 font-bold underline cursor-pointer"
            >
              فتح القناة النشطة الآن ↗
            </button>
          )}
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-xl bg-red-950/50 border border-red-500/40 px-3.5 py-2.5 text-xs text-red-200 font-semibold flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <span className="leading-relaxed">{errorMsg}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={checkingConn}
              onClick={() => void handleCheckConnection()}
              className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 text-[11px] font-bold cursor-pointer disabled:opacity-50"
            >
              {checkingConn ? 'جارٍ الفحص...' : 'فحص الاتصال'}
            </button>
            <button
              type="button"
              onClick={() => void loadState(false)}
              className="px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-[11px] font-black cursor-pointer"
            >
              إعادة المحاولة
            </button>
            <button type="button" onClick={() => setErrorMsg(null)} className="text-red-300 font-black cursor-pointer px-1">✕</button>
          </div>
        </div>
      )}

      {/* Audit Logs View */}
      {showAuditModal ? (
        <div className="rounded-2xl bg-[#0c1220] border border-slate-800 p-4 flex flex-col gap-2.5 max-h-[62vh] overflow-y-auto">
          <h2 className="text-sm font-black text-amber-300 mb-1">سجل التدقيق والعمليات المنفذة</h2>
          {auditLogs.length === 0 ? (
            <p className="text-xs text-slate-400 py-6 text-center">لا توجد عمليات مسجلة حتى الآن.</p>
          ) : (
            auditLogs.map((log) => (
              <div key={log.id} className="rounded-xl bg-[#080d18] border border-slate-800 p-3 text-xs flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-black text-slate-200">{log.actionType}</span>
                  <span
                    className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                      log.status === 'success'
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : log.status === 'pending'
                        ? 'bg-amber-500/20 text-amber-300'
                        : log.status === 'cancelled'
                        ? 'bg-slate-700 text-slate-300'
                        : 'bg-red-500/20 text-red-300'
                    }`}
                  >
                    {log.status === 'success' ? 'تم التنفيذ' : log.status === 'pending' ? 'بانتظار الاعتماد' : log.status === 'cancelled' ? 'ملغى' : 'خطأ'}
                  </span>
                </div>
                <div className="text-slate-400">الهدف: <span className="text-slate-200">{log.target}</span></div>
                <div className="text-slate-300">{log.details}</div>
                <div className="text-[10px] text-slate-500">{formatTimeAr(log.timestamp)} • {log.command}</div>
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          {/* Pending Account-Choice & Sensitive Action Confirmation Cards */}
          {openActions.map((act) => {
            if (act.actionType === 'choose_interaction_accounts') {
              const reqCount = Number(act.payload?.count || 3);
              const existingList = Array.isArray(act.payload?.existingAccounts)
                ? act.payload!.existingAccounts
                : [];
              const pickerOpen = Boolean(expandedExistingPicker[act.id]);
              const chosenIds = selectedExistingIds[act.id] || [];
              const q = String(existingSearchQuery[act.id] || '').trim().toLowerCase();
              const filteredExisting = q
                ? existingList.filter(
                    (u) =>
                      u.displayName.toLowerCase().includes(q) ||
                      u.username.toLowerCase().includes(q) ||
                      String(u.id).includes(q)
                  )
                : existingList;
              const isBusy = busyActionId === act.id;

              return (
                <div key={act.id} className="rounded-2xl bg-gradient-to-br from-amber-950/45 via-[#0e1526] to-[#0a1324] border-2 border-amber-400/70 p-4 shadow-xl">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                    <span className="text-xs sm:text-sm font-black text-amber-300">
                      اختيار حسابات المشاركين قبل التوليد باللهجة اليمنية
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-200 font-bold">
                      {reqCount} مشاركين • قناة «{act.payload?.channelName}»
                    </span>
                  </div>
                  <div className="text-sm font-bold text-white mb-1">{act.titleAr}</div>
                  <p className="text-xs text-slate-300 whitespace-pre-wrap mb-3">{act.summaryAr}</p>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleResolveAccountChoice(act.id, 'create_new')}
                      className="px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-black text-xs cursor-pointer disabled:opacity-50 shadow-md"
                    >
                      {isBusy ? 'جاري التنفيذ...' : `1️⃣ إنشاء ${reqCount} حسابات جديدة وتوليد باللهجة اليمنية`}
                    </button>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => {
                        setExpandedExistingPicker((prev) => ({ ...prev, [act.id]: !prev[act.id] }));
                        if (!selectedExistingIds[act.id] && existingList.length > 0) {
                          setSelectedExistingIds((prev) => ({
                            ...prev,
                            [act.id]: existingList.slice(0, reqCount).map((u) => u.id),
                          }));
                        }
                      }}
                      className="px-4 py-2 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-sky-200 font-black text-xs cursor-pointer disabled:opacity-50"
                    >
                      {`2️⃣ اختيار من الحسابات الحالية (${existingList.length})`}
                    </button>

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => handleCancelAction(act.id)}
                      className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs cursor-pointer disabled:opacity-50"
                    >
                      إلغاء
                    </button>
                  </div>

                  {pickerOpen && (
                    <div className="mt-3 rounded-xl bg-[#070b15] border border-sky-500/35 p-3 flex flex-col gap-2.5">
                      {existingList.length === 0 ? (
                        <div className="text-xs text-amber-200 leading-relaxed">
                          لا توجد حسابات أعضاء حالية مسجلة بعد غير حساب المالك. اضغط على زر «إنشاء {reqCount} حسابات جديدة» لإنشائها تلقائياً ثم توليد المواضيع باللهجة اليمنية.
                        </div>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-bold text-sky-200">
                              اختر الحسابات ({chosenIds.length} محددة من أصل {existingList.length} متاح):
                            </span>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  setSelectedExistingIds((prev) => ({
                                    ...prev,
                                    [act.id]: existingList.slice(0, reqCount).map((u) => u.id),
                                  }))
                                }
                                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-200 text-[10.5px] font-bold cursor-pointer"
                              >
                                تحديد {Math.min(reqCount, existingList.length)} تلقائياً
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setSelectedExistingIds((prev) => ({
                                    ...prev,
                                    [act.id]: existingList.map((u) => u.id),
                                  }))
                                }
                                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10.5px] font-bold cursor-pointer"
                              >
                                تحديد الكل
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setSelectedExistingIds((prev) => ({
                                    ...prev,
                                    [act.id]: [],
                                  }))
                                }
                                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 text-[10.5px] font-bold cursor-pointer"
                              >
                                مسح التحديد
                              </button>
                            </div>
                          </div>

                          {existingList.length > 6 && (
                            <input
                              type="text"
                              value={existingSearchQuery[act.id] || ''}
                              onChange={(e) =>
                                setExistingSearchQuery((prev) => ({ ...prev, [act.id]: e.target.value }))
                              }
                              placeholder="ابحث بالاسم أو @username..."
                              className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-white text-xs outline-none focus:border-sky-400"
                            />
                          )}

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-48 overflow-y-auto pr-1">
                            {filteredExisting.map((acc) => {
                              const checked = chosenIds.includes(acc.id);
                              return (
                                <label
                                  key={acc.id}
                                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs cursor-pointer transition-colors ${
                                    checked
                                      ? 'bg-sky-500/20 border-sky-400/60 text-white'
                                      : 'bg-slate-900/70 border-slate-800 text-slate-300 hover:bg-slate-800/80'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => {
                                      setSelectedExistingIds((prev) => {
                                        const cur = prev[act.id] || [];
                                        const next = cur.includes(acc.id)
                                          ? cur.filter((id) => id !== acc.id)
                                          : [...cur, acc.id];
                                        return { ...prev, [act.id]: next };
                                      });
                                    }}
                                    className="accent-amber-400"
                                  />
                                  <span className="font-bold truncate">{acc.displayName}</span>
                                  <span className="text-[10px] text-slate-400 font-mono mr-auto" dir="ltr">
                                    @{acc.username}
                                  </span>
                                </label>
                              );
                            })}
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800">
                            <span className="text-[11px] text-slate-400">
                              {chosenIds.length < reqCount && existingList.length < reqCount
                                ? `تنبيه: المتاح حالياً ${existingList.length} حساب فقط؛ سيتم التوليد للحسابات المحددة.`
                                : `سيتم توليد ${chosenIds.length} تفاعلات باللهجة اليمنية بأسماء الحسابات المحددة.`}
                            </span>
                            <button
                              type="button"
                              disabled={isBusy || chosenIds.length === 0}
                              onClick={() => handleResolveAccountChoice(act.id, 'select_existing', chosenIds)}
                              className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs cursor-pointer disabled:opacity-40"
                            >
                              {isBusy ? 'جاري التوليد...' : `توليد المواضيع باللهجة اليمنية (${chosenIds.length})`}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            }

            return (
              <div key={act.id} className="rounded-2xl bg-gradient-to-br from-amber-950/40 to-[#0e1526] border-2 border-amber-400/60 p-4 shadow-lg">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="text-xs sm:text-sm font-black text-amber-300">إجراء إداري بانتظار تأكيدك</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-200 font-bold">{act.actionType}</span>
                </div>
                <div className="text-sm font-bold text-white mb-1">{act.titleAr}</div>
                <p className="text-xs text-slate-300 whitespace-pre-wrap mb-3">{act.summaryAr}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busyActionId === act.id}
                    onClick={() => handleConfirmAction(act.id)}
                    className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs cursor-pointer disabled:opacity-50"
                  >
                    {busyActionId === act.id ? 'جاري التنفيذ...' : 'تأكيد وتنفيذ الآن'}
                  </button>
                  <button
                    type="button"
                    disabled={busyActionId === act.id}
                    onClick={() => handleCancelAction(act.id)}
                    className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs cursor-pointer disabled:opacity-50"
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            );
          })}

          {/* Live Staggered Publishing Progress Cards */}
          {publishingDrafts.map((draft) => {
            const total = draft.items?.length || 0;
            const sent = Math.min(total, Number(draft.publishedCount || 0));
            const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
            const secLeft = draft.nextPublishAt ? Math.max(0, Math.ceil((draft.nextPublishAt - nowMs) / 1000)) : 0;
            const isBusy = busyDraftId === draft.id;
            return (
              <div key={draft.id} className="rounded-2xl bg-gradient-to-br from-emerald-950/35 to-[#0c1425] border-2 border-emerald-400/50 p-4 shadow-xl">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div>
                    <div className="text-xs sm:text-sm font-black text-emerald-300">
                      جاري النشر المجدول في قناة «{draft.channelName}» ({sent} / {total})
                    </div>
                    <div className="text-[11px] text-slate-300 mt-0.5">
                      الفاصل الزمني: كل <span className="text-amber-300 font-bold">{draft.intervalSeconds || 0}</span> ثانية
                      {secLeft > 0 ? ` • الرسالة التالية خلال ${secLeft} ثانية` : ' • جاري إرسال الرسالة التالية...'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleCancelDraft(draft.id)}
                    className="px-3.5 py-1.5 rounded-xl bg-red-600/80 hover:bg-red-600 text-white font-bold text-xs cursor-pointer disabled:opacity-50"
                  >
                    {isBusy ? 'جاري الإيقاف...' : 'إيقاف الإرسال المتبقي'}
                  </button>
                </div>
                <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-400 to-amber-400 transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}

          {/* Pending Virtual Persona Draft Review & Publish Cards */}
          {openDrafts.map((draft) => {
            const items = getDraftItems(draft);
            const isEditing = editingDraftId === draft.id;
            const isBusy = busyDraftId === draft.id;
            const intervalSec = getDraftInterval(draft);
            const totalDurationSec = items.length > 1 ? intervalSec * (items.length - 1) : 0;
            const totalMins = Math.floor(totalDurationSec / 60);
            const remSecs = totalDurationSec % 60;
            return (
              <div key={draft.id} className="rounded-2xl bg-[#0c1425] border-2 border-amber-400/60 p-4 shadow-xl">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div>
                    <div className="text-xs sm:text-sm font-black text-amber-300">
                      مراجعة مسودة التفاعلات ({items.length}) • قناة «{draft.channelName}»
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">الموضوع: {draft.topic}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (!isEditing && !draftEdits[draft.id]) {
                        setDraftEdits((prev) => ({ ...prev, [draft.id]: draft.items.map((x) => ({ ...x })) }));
                      }
                      setEditingDraftId(isEditing ? null : draft.id);
                    }}
                    className="px-3 py-1 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 text-[11px] font-bold cursor-pointer border border-slate-700"
                  >
                    {isEditing ? 'إنهاء التعديل' : 'تعديل قبل النشر'}
                  </button>
                </div>

                <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1 my-2">
                  {items.map((item, idx) => (
                    <div key={item.id || idx} className="rounded-xl bg-[#070b15] border border-slate-800 p-2.5 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-black text-slate-500">#{idx + 1}</span>
                          {isEditing ? (
                            <input
                              type="text"
                              value={item.personaName}
                              onChange={(e) => {
                                const val = e.target.value;
                                setDraftEdits((prev) => ({
                                  ...prev,
                                  [draft.id]: (prev[draft.id] || draft.items).map((x, i) =>
                                    i === idx ? { ...x, personaName: val } : x
                                  ),
                                }));
                              }}
                              className="px-2 py-0.5 rounded-lg bg-slate-900 border border-slate-700 text-amber-300 font-bold text-xs outline-none"
                            />
                          ) : (
                            <span className="font-black text-amber-300">{item.personaName}</span>
                          )}
                          <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                            {item.dialect}
                          </span>
                        </div>
                        {isEditing && items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => {
                              setDraftEdits((prev) => ({
                                ...prev,
                                [draft.id]: (prev[draft.id] || draft.items).filter((_, i) => i !== idx),
                              }));
                            }}
                            className="text-red-400 hover:text-red-300 text-[11px] font-bold cursor-pointer"
                          >
                            حذف
                          </button>
                        )}
                      </div>
                      {isEditing ? (
                        <textarea
                          rows={2}
                          value={item.text}
                          onChange={(e) => {
                            const val = e.target.value;
                            setDraftEdits((prev) => ({
                              ...prev,
                              [draft.id]: (prev[draft.id] || draft.items).map((x, i) =>
                                i === idx ? { ...x, text: val } : x
                              ),
                            }));
                          }}
                          className="w-full px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-100 text-xs outline-none mt-1"
                        />
                      ) : (
                        <p className="text-slate-200 leading-relaxed">{item.text}</p>
                      )}
                    </div>
                  ))}
                </div>

                {/* Configurable Interval Between Persona Messages */}
                <div className="rounded-xl bg-[#070b15] border border-slate-800 p-3 my-2 flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-black text-amber-200">الفاصل الزمني بين كل رسالة وأخرى:</span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={0}
                        max={3600}
                        step={1}
                        value={intervalSec}
                        onChange={(e) => {
                          const v = Math.max(0, Math.min(3600, Math.round(Number(e.target.value) || 0)));
                          setDraftIntervals((prev) => ({ ...prev, [draft.id]: v }));
                        }}
                        className="w-20 px-2.5 py-1 rounded-lg bg-slate-900 border border-amber-500/40 text-amber-300 font-black text-xs text-center outline-none focus:border-amber-400"
                      />
                      <span className="text-[11px] text-slate-300 font-bold">ثانية</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { label: 'فوري (0 ث)', val: 0 },
                      { label: '10 ثوانٍ', val: 10 },
                      { label: '30 ثانية', val: 30 },
                      { label: '60 ثانية', val: 60 },
                      { label: '120 ثانية', val: 120 },
                    ].map((preset) => (
                      <button
                        key={preset.val}
                        type="button"
                        onClick={() => setDraftIntervals((prev) => ({ ...prev, [draft.id]: preset.val }))}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border cursor-pointer transition-colors ${
                          intervalSec === preset.val
                            ? 'bg-amber-500/25 border-amber-400 text-amber-200'
                            : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {intervalSec <= 0 || items.length <= 1
                      ? 'سيتم نشر جميع الرسائل مباشرة دفعة واحدة.'
                      : `سيتم إرسال الرسالة الأولى فوراً، ثم رسالة لكل شخصية كل ${intervalSec} ثانية (المدة الإجمالية التقريبية: ${
                          totalMins > 0 ? `${totalMins} دقيقة${remSecs > 0 ? ` و ${remSecs} ثانية` : ''}` : `${remSecs} ثانية`
                        }).`}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleApproveDraft(draft)}
                    className="px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-black text-xs cursor-pointer disabled:opacity-50 shadow-md"
                  >
                    {isBusy
                      ? 'جاري بدء النشر...'
                      : intervalSec > 0 && items.length > 1
                      ? `اعتماد ونشر (${items.length}) كل ${intervalSec} ثانية`
                      : `اعتماد ونشر (${items.length}) الآن`}
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleCancelDraft(draft.id)}
                    className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs cursor-pointer disabled:opacity-50"
                  >
                    إلغاء المسودة
                  </button>
                </div>
              </div>
            );
          })}

          {/* Chat Conversation Area */}
          <div className="rounded-2xl bg-[#090e1a] border border-slate-800/90 p-3 sm:p-4 flex flex-col gap-3 min-h-[340px] max-h-[54vh] overflow-y-auto">
            {loading ? (
              <div className="py-12 text-center text-xs text-slate-400">جاري تحميل المحادثة الخاصة بالمالك...</div>
            ) : messages.length === 0 ? (
              <div className="py-8 text-center flex flex-col items-center gap-3">
                <div className="text-amber-300 font-black text-sm">مرحباً بك يا قائد سليم في المساعد الذكي</div>
                <p className="text-xs text-slate-400 max-w-md leading-relaxed">
                  اكتب أي أمر باللغة العربية — مثل التنقل بين القنوات، قراءة الرسائل، إعداد تفاعلات متنوعة للأعضاء ومراجعتها قبل النشر، أو إدارة القنوات والأعضاء.
                </p>
                <div className="flex flex-wrap justify-center gap-2 mt-1">
                  {QUICK_COMMANDS.map((cmd) => (
                    <button
                      key={cmd}
                      type="button"
                      onClick={() => handleSend(cmd)}
                      className="px-3 py-1.5 rounded-xl bg-[#11192c] hover:bg-[#17233d] border border-amber-500/25 text-[11px] text-slate-200 font-semibold cursor-pointer transition-colors"
                    >
                      {cmd}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => {
                const isUser = m.role === 'user';
                return (
                  <div key={m.id} className={`flex flex-col ${isUser ? 'items-start' : 'items-end'}`}>
                    <div
                      className={`max-w-[92%] sm:max-w-[82%] rounded-2xl px-3.5 py-2.5 text-xs sm:text-[13px] leading-relaxed ${
                        isUser
                          ? 'bg-gradient-to-br from-amber-500/25 to-amber-600/10 border border-amber-400/50 text-white'
                          : 'bg-[#121a2d] border border-slate-700/80 text-slate-100'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3 mb-1 text-[10px]">
                        <span className={`font-black ${isUser ? 'text-amber-300' : 'text-emerald-300'}`}>
                          {isUser ? '👑 القائد Salim' : '✦ المساعد الذكي'}
                        </span>
                        <span className="text-slate-500">{formatTimeAr(m.timestamp)}</span>
                      </div>

                      {m.toolSteps && m.toolSteps.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {m.toolSteps.map((st, idx) => (
                            <span
                              key={idx}
                              className={`text-[10px] px-2 py-0.5 rounded-lg border font-bold ${
                                st.status === 'ok'
                                  ? 'bg-emerald-500/15 border-emerald-400/30 text-emerald-300'
                                  : st.status === 'pending_confirmation'
                                  ? 'bg-amber-500/15 border-amber-400/40 text-amber-200'
                                  : 'bg-red-500/15 border-red-400/30 text-red-300'
                              }`}
                            >
                              {st.labelAr}: {st.summaryAr}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="whitespace-pre-wrap">{m.text}</div>

                      {m.createdAccounts && m.createdAccounts.length > 0 && (
                        <div className="mt-2.5 rounded-xl bg-[#080d19] border border-emerald-500/35 p-2.5 flex flex-col gap-2">
                          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] font-black text-emerald-300">
                                بيانات الحسابات المُنشأة ({m.createdAccounts.length})
                              </span>
                              <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-400/30 text-emerald-200 font-bold">
                                صلاحية: user
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  setRevealedPasswords((prev) => ({ ...prev, [m.id]: !prev[m.id] }))
                                }
                                className="px-2 py-0.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[10px] font-bold cursor-pointer"
                              >
                                {revealedPasswords[m.id] ? 'إخفاء كلمات المرور' : 'إظهار كلمات المرور'}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const allTxt = m.createdAccounts!
                                    .map(
                                      (a, idx) =>
                                        `${idx + 1}. ${a.displayName} | Username: ${a.username} | Password: ${a.password} | Role: ${a.role}`
                                    )
                                    .join('\n');
                                  void copyTextToClipboard(allTxt, 'تم نسخ بيانات الدخول لجميع الحسابات.');
                                }}
                                className="px-2 py-0.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-200 text-[10px] font-bold cursor-pointer"
                              >
                                نسخ الكل
                              </button>
                              <button
                                type="button"
                                onClick={() => exportAccountsCsv(m.createdAccounts!)}
                                className="px-2 py-0.5 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/40 text-sky-200 text-[10px] font-bold cursor-pointer"
                              >
                                تصدير CSV
                              </button>
                            </div>
                          </div>

                          <div className="flex flex-col gap-1.5 max-h-60 overflow-y-auto">
                            {m.createdAccounts.map((acc) => {
                              const showPass = Boolean(revealedPasswords[m.id]);
                              return (
                                <div
                                  key={acc.id}
                                  className="rounded-lg bg-[#0d1424] border border-slate-800 px-2.5 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px]"
                                >
                                  <div className="flex flex-col gap-0.5">
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-[10px] text-slate-500 font-bold">#{acc.id}</span>
                                      <span className="font-black text-white">{acc.displayName}</span>
                                      <span className="text-[9.5px] px-1.5 py-0.2 rounded bg-slate-800 text-emerald-300 font-bold">
                                        {acc.role}
                                      </span>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2.5 text-[10.5px] text-slate-300 font-mono" dir="ltr">
                                      <span>
                                        user: <strong className="text-amber-300">{acc.username}</strong>
                                      </span>
                                      <span>
                                        pass:{' '}
                                        <strong className="text-emerald-300">
                                          {showPass ? acc.password : '••••••••••••'}
                                        </strong>
                                      </span>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void copyTextToClipboard(
                                        `الاسم: ${acc.displayName}\nاسم المستخدم: ${acc.username}\nكلمة المرور: ${acc.password}`,
                                        `تم نسخ بيانات دخول @${acc.username}`
                                      )
                                    }
                                    className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-200 text-[10px] font-bold cursor-pointer shrink-0"
                                  >
                                    نسخ الدخول
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {m.navigation && onNavigate && (
                        <button
                          type="button"
                          onClick={() => onNavigate(m.navigation!)}
                          className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-200 text-[11px] font-bold cursor-pointer"
                        >
                          فتح {formatNavigationLabelAr(m.navigation)} ↗
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}

            {sending && (
              <div className="flex items-end flex-col">
                <div className="rounded-2xl px-3.5 py-2 bg-[#121a2d] border border-amber-500/30 text-xs text-amber-200 font-bold">
                  جاري تنفيذ الأمر ومعالجة الطلب...
                </div>
              </div>
            )}
            <div ref={scrollEndRef} />
          </div>

          {/* Quick Command Chips when conversation exists */}
          {messages.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {QUICK_COMMANDS.map((cmd) => (
                <button
                  key={cmd}
                  type="button"
                  disabled={sending}
                  onClick={() => handleSend(cmd)}
                  className="px-2.5 py-1 rounded-xl bg-[#0e1526] hover:bg-[#16213a] border border-slate-800 text-[10.5px] text-slate-300 cursor-pointer disabled:opacity-50"
                >
                  {cmd}
                </button>
              ))}
            </div>
          )}

          {/* Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="flex items-end gap-2 bg-[#0c1322] border border-amber-500/30 rounded-2xl p-2"
          >
            <textarea
              rows={2}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="اكتب أمرك بالعربية هنا... مثال: توجّه إلى القناة العامة وأنشئ 10 تفاعلات حول..."
              className="flex-1 bg-transparent text-white text-xs sm:text-sm px-2.5 py-1.5 outline-none resize-none placeholder:text-slate-500"
            />
            <button
              type="submit"
              disabled={sending || !inputText.trim()}
              className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-slate-950 font-black text-xs sm:text-sm cursor-pointer disabled:opacity-40 shrink-0 shadow-lg"
            >
              {sending ? 'تنفيذ...' : 'إرسال'}
            </button>
          </form>
        </>
      )}
    </div>
  );
}

if (typeof window !== 'undefined') {
  (window as any).SamiAiAssistantPanel = SamiAiAssistantPanel;
}
