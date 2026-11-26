// Background Push Notification Activation & Lock-Screen Readiness Helper for Salim
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var BANNER_ID = 'salim-push-helper-banner';
  var DISMISS_KEY = 'salim_push_banner_dismissed_v1';

  function isLocalApk() {
    try {
      return window.location.hostname === 'appassets.androidplatform.net' || window.location.protocol === 'file:';
    } catch (_) {
      return false;
    }
  }

  function getApiBase() {
    if (!isLocalApk()) return '';
    try {
      if (typeof window.getSamiServerBaseUrl === 'function') {
        var b = String(window.getSamiServerBaseUrl() || '').trim();
        if (b && !b.includes('wrwn7qrad4ng4e3ejalosp')) return b.replace(/\/+$/, '');
      }
      var s = localStorage.getItem('sami_push_server_url');
      if (s && s.startsWith('https://') && !s.includes('wrwn7qrad4ng4e3ejalosp')) {
        return s.replace(/\/+$/, '');
      }
    } catch (_) {}
    return 'https://ais-pre-ljvmb2ezkv67qiojp5xgpk-877998647748.europe-west2.run.app';
  }

  function getSession() {
    try {
      var raw = localStorage.getItem('sami_auth_user_session');
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && Number(parsed.id) > 0 && Number(parsed.id) < 9000000) {
        return parsed;
      }
    } catch (_) {}
    return null;
  }

  function getDeviceId() {
    try {
      var existing = localStorage.getItem('sami_device_id');
      if (existing) return existing;
      var created = 'web_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('sami_device_id', created);
      return created;
    } catch (_) {
      return 'web_default';
    }
  }

  function buildHeaders(sess) {
    var headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (sess) {
      if (sess.token) headers['Authorization'] = 'Bearer ' + sess.token;
      try {
        headers['x-sami-session'] = encodeURIComponent(
          JSON.stringify({
            id: Number(sess.id),
            username: String(sess.username || ''),
            displayName: String(sess.displayName || sess.username || ''),
            role: String(sess.role || 'user'),
            isGuest: false,
            isRestrictedAdmin: Boolean(sess.isRestrictedAdmin || Number(sess.id) === 76 || Number(sess.id) === 77),
          })
        );
      } catch (_) {}
    }
    return headers;
  }

  function urlB64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i += 1) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function isIosNonStandalone() {
    try {
      var ua = navigator.userAgent || '';
      var isIos = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
      var isStandalone = Boolean(window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches));
      return isIos && !isStandalone;
    } catch (_) {
      return false;
    }
  }

  async function ensureSubscribed(sess, interactive) {
    if (!sess || !sess.id) return { ok: false, reason: 'no_session' };
    if (window.SamiBridge && typeof window.SamiBridge.getFcmToken === 'function') {
      return { ok: true, nativeApk: true };
    }
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      return { ok: false, reason: isIosNonStandalone() ? 'ios_homescreen' : 'unsupported' };
    }

    var perm = Notification.permission;
    if (perm === 'default' && interactive) {
      perm = await Notification.requestPermission();
      try {
        window.dispatchEvent(new CustomEvent('sami_permission_updated'));
      } catch (_) {}
    }
    if (perm !== 'granted') {
      return { ok: false, reason: perm };
    }

    var reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
    if (reg.update) reg.update().catch(function () {});
    await navigator.serviceWorker.ready;

    var base = getApiBase();
    var keyRes = await fetch(base + '/api/fcm/vapid-public-key', { cache: 'no-store' });
    if (!keyRes.ok) return { ok: false, reason: 'vapid_fetch_failed' };
    var keyData = await keyRes.json();
    if (!keyData || !keyData.publicKey) return { ok: false, reason: 'vapid_missing' };

    var appKey = urlB64ToUint8Array(keyData.publicKey);
    var sub = await reg.pushManager.getSubscription();
    if (sub && sub.options && sub.options.applicationServerKey) {
      try {
        var cur = new Uint8Array(sub.options.applicationServerKey);
        var mismatch = cur.length !== appKey.length || cur.some(function (v, idx) { return v !== appKey[idx]; });
        if (mismatch) {
          await sub.unsubscribe().catch(function () {});
          sub = null;
        }
      } catch (_) {}
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appKey,
      });
    }
    if (!sub || !sub.endpoint) return { ok: false, reason: 'subscribe_failed' };

    var subJson = typeof sub.toJSON === 'function' ? sub.toJSON() : sub;
    var devId = getDeviceId();
    var regRes = await fetch(base + '/api/fcm/register', {
      method: 'POST',
      headers: buildHeaders(sess),
      body: JSON.stringify({
        userId: Number(sess.id),
        username: sess.displayName || sess.username || '',
        token: sub.endpoint,
        deviceId: devId,
        platform: 'web',
        deviceModel: (navigator.userAgent || '').slice(0, 120),
        subscription: subJson,
      }),
    });

    try {
      var sw = reg.active || navigator.serviceWorker.controller;
      if (sw) {
        sw.postMessage({
          type: 'SALIM_SYNC_PUSH_STANDBY',
          payload: {
            userId: Number(sess.id),
            username: String(sess.displayName || sess.username || ''),
            deviceId: devId,
            apiBase: base || window.location.origin,
            authHeaders: buildHeaders(sess),
            subscription: subJson,
            updatedAt: Date.now(),
          },
        });
      }
    } catch (_) {}

    return { ok: regRes.ok, sub: subJson };
  }

  function removeBanner() {
    var existing = document.getElementById(BANNER_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function renderBanner(mode, sess) {
    if (document.getElementById(BANNER_ID)) return;
    if (sessionStorage.getItem(DISMISS_KEY) === '1' && mode !== 'test') return;

    var wrap = document.createElement('div');
    wrap.id = BANNER_ID;
    wrap.dir = 'rtl';
    wrap.style.cssText =
      'position:fixed;bottom:14px;left:12px;right:12px;max-width:460px;margin:0 auto;z-index:9999;' +
      'background:linear-gradient(135deg,#0f172a 0%,#171206 100%);border:1px solid rgba(245,158,11,0.55);' +
      'border-radius:16px;padding:12px 14px;box-shadow:0 12px 32px rgba(0,0,0,0.65);' +
      'color:#f8fafc;font-family:Cairo,sans-serif;display:flex;flex-direction:column;gap:8px;';

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

    var title = document.createElement('div');
    title.style.cssText = 'font-size:13px;font-weight:800;color:#fbbf24;';
    title.textContent =
      mode === 'ios'
        ? '📲 لتصلك إشعارات Salim والشاشة مقفلة'
        : mode === 'denied'
          ? '🔕 الإشعارات محظورة من إعدادات المتصفح'
          : '🔔 تفعيل إشعارات الهاتف الفورية';

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.style.cssText =
      'background:transparent;border:none;color:#94a3b8;font-size:15px;font-weight:700;cursor:pointer;padding:2px 6px;';
    closeBtn.onclick = function () {
      sessionStorage.setItem(DISMISS_KEY, '1');
      removeBanner();
    };

    header.appendChild(title);
    header.appendChild(closeBtn);
    wrap.appendChild(header);

    var desc = document.createElement('div');
    desc.style.cssText = 'font-size:11.5px;line-height:1.5;color:#cbd5e1;';
    if (mode === 'ios') {
      desc.textContent = 'على الآيفون: اضغط زر المشاركة (⬆) ثم «إضافة إلى الشاشة الرئيسية» وافتح التطبيق من الأيقونة لتفعيل الإشعارات.';
      wrap.appendChild(desc);
      document.body.appendChild(wrap);
      return;
    }

    desc.textContent =
      mode === 'denied'
        ? 'افتح أيقونة القفل بجانب رابط الموقع في المتصفح واسمح بـ «الإشعارات» ثم أعد تحميل الصفحة.'
        : 'اسمح بالإشعارات الآن لتصلك الرسائل الصوتية والنصية على شاشة قفل الهاتف حتى عند إغلاق التطبيق مثل واتساب.';
    wrap.appendChild(desc);

    var statusLine = document.createElement('div');
    statusLine.style.cssText = 'font-size:11px;color:#34d399;display:none;font-weight:700;';
    wrap.appendChild(statusLine);

    if (mode !== 'denied') {
      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:2px;';

      var activateBtn = document.createElement('button');
      activateBtn.type = 'button';
      activateBtn.textContent = 'تفعيل الإشعارات الآن';
      activateBtn.style.cssText =
        'flex:1;min-width:140px;padding:8px 12px;border-radius:10px;border:none;' +
        'background:linear-gradient(90deg,#f59e0b,#fbbf24);color:#090d16;font-size:12px;font-weight:900;cursor:pointer;';

      var testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.textContent = 'اختبار بعد 4 ثوانٍ (اقفل الشاشة)';
      testBtn.style.cssText =
        'display:none;padding:8px 12px;border-radius:10px;border:1px solid rgba(56,189,248,0.45);' +
        'background:rgba(14,165,233,0.16);color:#bae6fd;font-size:11.5px;font-weight:800;cursor:pointer;';

      activateBtn.onclick = async function () {
        activateBtn.disabled = true;
        activateBtn.textContent = 'جارٍ التفعيل...';
        try {
          var res = await ensureSubscribed(sess, true);
          if (res.ok) {
            statusLine.style.display = 'block';
            statusLine.style.color = '#34d399';
            statusLine.textContent = '✅ تم ربط هاتفك بنجاح! تصلك الإشعارات الآن حتى في الخلفية.';
            activateBtn.textContent = 'مفعّل ✓';
            testBtn.style.display = 'inline-block';
          } else if (res.reason === 'denied') {
            statusLine.style.display = 'block';
            statusLine.style.color = '#fca5a5';
            statusLine.textContent = 'تم رفض الإذن من المتصفح — فعّل الإشعارات من إعدادات الموقع بجانب الرابط.';
            activateBtn.disabled = false;
            activateBtn.textContent = 'إعادة المحاولة';
          } else {
            statusLine.style.display = 'block';
            statusLine.style.color = '#fcd34d';
            statusLine.textContent = 'يرجى السماح بالإشعارات في النافذة المنبثقة ثم المحاولة مجدداً.';
            activateBtn.disabled = false;
            activateBtn.textContent = 'تفعيل الإشعارات الآن';
          }
        } catch (_) {
          activateBtn.disabled = false;
          activateBtn.textContent = 'إعادة المحاولة';
        }
      };

      testBtn.onclick = async function () {
        testBtn.disabled = true;
        testBtn.textContent = 'سيصل خلال 4 ثوانٍ...';
        try {
          var r = await fetch(getApiBase() + '/api/fcm/test', {
            method: 'POST',
            headers: buildHeaders(sess),
            body: JSON.stringify({ userId: Number(sess.id), delayMs: 4000 }),
          });
          if (r.ok) {
            statusLine.style.display = 'block';
            statusLine.style.color = '#7dd3fc';
            statusLine.textContent = '⏳ اقفل شاشة الهاتف أو أخرج من التطبيق الآن — سيصلك إشعار خلال 4 ثوانٍ.';
            setTimeout(function () {
              removeBanner();
            }, 6000);
          } else {
            testBtn.disabled = false;
            testBtn.textContent = 'إعادة الاختبار';
          }
        } catch (_) {
          testBtn.disabled = false;
          testBtn.textContent = 'إعادة الاختبار';
        }
      };

      btnRow.appendChild(activateBtn);
      btnRow.appendChild(testBtn);
      wrap.appendChild(btnRow);
    }

    document.body.appendChild(wrap);
  }

  async function checkAndSetup() {
    var sess = getSession();
    if (!sess) return;
    if (window.SamiBridge && typeof window.SamiBridge.getFcmToken === 'function') return;

    if (isIosNonStandalone()) {
      renderBanner('ios', sess);
      return;
    }

    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      return;
    }

    if (Notification.permission === 'granted') {
      await ensureSubscribed(sess, false).catch(function () {});
      removeBanner();
      return;
    }

    if (Notification.permission === 'denied') {
      renderBanner('denied', sess);
      return;
    }

    renderBanner('prompt', sess);
  }

  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(checkAndSetup, 1200);
  });
  window.addEventListener('sami_permission_updated', function () {
    setTimeout(checkAndSetup, 400);
  });
  window.addEventListener('storage', function (e) {
    if (e && e.key === 'sami_auth_user_session') {
      setTimeout(checkAndSetup, 500);
    }
  });
  // Poll briefly after login in same tab
  var lastUid = 0;
  setInterval(function () {
    var s = getSession();
    var uid = s ? Number(s.id) : 0;
    if (uid > 0 && uid !== lastUid) {
      lastUid = uid;
      checkAndSetup();
    }
  }, 2500);
})();
