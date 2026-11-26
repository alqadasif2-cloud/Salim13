/**
 * Salim Channels & Navigation Visual/Motion FX Engine
 * - Hardware-profile adaptive & WebView compatible (Android 7.0+ / 2GB+ RAM through flagship devices)
 * - 1. Smooth traveling golden energy dock indicator across all bottom nav tabs
 * - 2. Smooth, organic golden electric arcs, flashes & sparks transferring randomly across visible channel cards
 * - Never auto-disables animations on older/low-RAM hardware; tunes frame budget, DPR, and geometry complexity cleanly
 */
(function () {
  'use strict';

  var docEl = document.documentElement;

  function nowMs() {
    return window.performance && typeof window.performance.now === 'function'
      ? window.performance.now()
      : Date.now();
  }

  function isDocHidden() {
    return Boolean(document.hidden || document.webkitHidden);
  }

  function isNodeConnected(el) {
    if (!el) return false;
    if (typeof el.isConnected === 'boolean') return el.isConnected;
    return docEl.contains(el);
  }

  var rafFn =
    window.requestAnimationFrame ||
    window.webkitRequestAnimationFrame ||
    function (cb) {
      return setTimeout(function () {
        cb(nowMs());
      }, 16);
    };

  var cancelRafFn =
    window.cancelAnimationFrame ||
    window.webkitCancelAnimationFrame ||
    function (id) {
      clearTimeout(id);
    };

  function requestRaf(cb) {
    return rafFn.call(window, cb);
  }

  function cancelRaf(id) {
    if (id) cancelRafFn.call(window, id);
  }

  function matchesClosest(target, selector) {
    if (!target) return null;
    if (typeof target.closest === 'function') return target.closest(selector);
    var cur = target;
    while (cur && cur.nodeType === 1) {
      if (cur.classList && cur.classList.contains(selector.replace(/^\./, ''))) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /* ------------------------------------------------------------------------
   * 1. ADAPTIVE DEVICE PERFORMANCE TIER (ALWAYS ANIMATED: compat / balanced / ultra)
   * ------------------------------------------------------------------------ */
  function computePerfTier() {
    var profile = window.__samiDeviceProfile || {};
    var isLegacy = Boolean(window.__samiIsLegacyAndroid || profile.isLegacyAndroid || docEl.classList.contains('sami-legacy-android'));
    var totalRamMb = Number(profile.totalRamMb) || 0;
    var memGb = Number(profile.deviceMemoryGb) || Number(navigator.deviceMemory) || (totalRamMb ? totalRamMb / 1024 : 4);
    var cores = Number(profile.cpuCores) || Number(navigator.hardwareConcurrency) || 4;
    var androidVer = Number(profile.androidVer) || 0;
    var chromeVer = Number(profile.chromeVer) || 0;
    var gpuLower = String(profile.gpuRenderer || '').toLowerCase();
    var isLowRam = Boolean(profile.isLowRam) || (totalRamMb > 0 && totalRamMb <= 2600) || (memGb > 0 && memGb <= 2.2);
    var isUltraOldGpu =
      Boolean(profile.isSoftwareGpu) ||
      gpuLower.indexOf('mali-t') !== -1 ||
      gpuLower.indexOf('mali-4') !== -1 ||
      gpuLower.indexOf('adreno (tm) 3') !== -1 ||
      gpuLower.indexOf('adreno (tm) 4') !== -1 ||
      gpuLower.indexOf('powervr') !== -1;
    var isMidGpu = Boolean(profile.isLegacyMaliOrLowGpu) || gpuLower.indexOf('mali-g52') !== -1 || gpuLower.indexOf('mali-g51') !== -1;

    // 2GB RAM / Mali-T720 / Mali-4xx / Android 7-8 / older WebViews: smooth 24fps DPR 1.0 animated tier
    if (
      isLowRam ||
      isUltraOldGpu ||
      (androidVer > 0 && androidVer < 9) ||
      (chromeVer > 0 && chromeVer < 80)
    ) {
      return 'compat';
    }

    // 3-4GB RAM / Mali-G52 (Galaxy A13, Galaxy S8 updated) / <= 6 cores: smooth 36fps DPR 1.25 animated tier
    if (isLegacy || isMidGpu || memGb < 5.5 || cores < 8 || (androidVer > 0 && androidVer < 11)) {
      return 'balanced';
    }

    return 'ultra';
  }

  var perfTier = computePerfTier();

  function applyPerfTier(tier) {
    perfTier = tier;
    docEl.dataset.salimFxTier = tier;
    docEl.classList.remove('salim-fx-lite', 'salim-fx-compat', 'salim-fx-balanced', 'salim-fx-ultra');
    docEl.classList.add('salim-fx-' + tier);
  }

  applyPerfTier(perfTier);

  /* ------------------------------------------------------------------------
   * 2. BOTTOM NAVIGATION TRAVELING GOLDEN ENERGY & SPARK TRANSFER
   * ------------------------------------------------------------------------ */
  var lastNavTabKey = null;
  var navBurstTimer = null;
  var navRafId = 0;

  function updateNavTraveler(forceInstant) {
    var dock = document.querySelector('.salim-nav-dock');
    if (!dock) return;

    var inner = dock.querySelector('.salim-nav-inner');
    var traveler = dock.querySelector('.salim-nav-traveler');
    if (!inner || !traveler) return;

    var activeBtn = inner.querySelector('.salim-nav-tab.is-active');
    if (!activeBtn) {
      traveler.style.opacity = '0';
      return;
    }

    // Batch layout reads before style writes
    var btnLeft = activeBtn.offsetLeft;
    var btnWidth = activeBtn.offsetWidth;
    var centerX = btnLeft + btnWidth * 0.5;
    var tabKey = activeBtn.getAttribute('data-salim-tab') || String(Math.round(centerX));

    if (forceInstant || lastNavTabKey === null) {
      traveler.classList.add('no-transition');
      traveler.style.webkitTransform = 'translate3d(' + centerX.toFixed(1) + 'px, 0, 0)';
      traveler.style.transform = 'translate3d(' + centerX.toFixed(1) + 'px, 0, 0)';
      traveler.style.opacity = '1';
      void traveler.offsetWidth;
      traveler.classList.remove('no-transition');
      lastNavTabKey = tabKey;
      return;
    }

    traveler.style.opacity = '1';
    traveler.style.webkitTransform = 'translate3d(' + centerX.toFixed(1) + 'px, 0, 0)';
    traveler.style.transform = 'translate3d(' + centerX.toFixed(1) + 'px, 0, 0)';

    if (lastNavTabKey !== tabKey) {
      lastNavTabKey = tabKey;
      traveler.classList.remove('is-traveling');
      activeBtn.classList.remove('is-just-activated');
      void traveler.offsetWidth;
      traveler.classList.add('is-traveling');
      activeBtn.classList.add('is-just-activated');

      if (navBurstTimer) clearTimeout(navBurstTimer);
      navBurstTimer = setTimeout(function () {
        if (traveler) traveler.classList.remove('is-traveling');
        if (activeBtn) activeBtn.classList.remove('is-just-activated');
      }, 420);
    }
  }

  function scheduleNavUpdate(forceInstant) {
    if (navRafId) cancelRaf(navRafId);
    navRafId = requestRaf(function () {
      navRafId = 0;
      updateNavTraveler(forceInstant);
    });
  }

  document.addEventListener(
    'click',
    function (ev) {
      var btn = matchesClosest(ev.target, '.salim-nav-tab');
      if (!btn) return;
      scheduleNavUpdate(false);
    },
    true
  );

  window.addEventListener(
    'resize',
    function () {
      scheduleNavUpdate(true);
      if (slotPrimary && slotPrimary.card) syncCanvasSize(slotPrimary);
      if (slotFading && slotFading.card) syncCanvasSize(slotFading);
      if (stagePresent && !cardObserver) probeVisibleCardsByRect();
    },
    { passive: true }
  );

  window.addEventListener('popstate', function () {
    setTimeout(syncDomState, 40);
  });
  window.addEventListener('hashchange', function () {
    setTimeout(syncDomState, 40);
  });
  window.addEventListener('app_open_chat_message', function () {
    setTimeout(syncDomState, 60);
  });

  /* ------------------------------------------------------------------------
   * 2B. ZERO-LATENCY TACTILE PRESS FEEDBACK FOR "FULL DETAILS" CTA BUTTONS
   * ------------------------------------------------------------------------ */
  var ctaPressTimers = typeof WeakMap === 'function' ? new WeakMap() : null;
  var activePressedCta = null;

  function triggerCtaPress(btn) {
    if (!btn) return;
    if (ctaPressTimers) {
      var prevTimer = ctaPressTimers.get(btn);
      if (prevTimer) clearTimeout(prevTimer);
    }
    activePressedCta = btn;
    btn.classList.add('is-pressed');
  }

  function releaseCtaPress(btn, immediate) {
    var targetBtn = btn || activePressedCta;
    if (!targetBtn) return;
    if (targetBtn === activePressedCta) {
      activePressedCta = null;
    }
    if (ctaPressTimers) {
      var prevTimer = ctaPressTimers.get(targetBtn);
      if (prevTimer) clearTimeout(prevTimer);
    }
    if (immediate) {
      targetBtn.classList.remove('is-pressed');
      return;
    }
    var tid = setTimeout(function () {
      targetBtn.classList.remove('is-pressed');
      if (ctaPressTimers) ctaPressTimers.delete(targetBtn);
    }, 110);
    if (ctaPressTimers) {
      ctaPressTimers.set(targetBtn, tid);
    }
  }

  if (window.PointerEvent) {
    document.addEventListener(
      'pointerdown',
      function (ev) {
        var btn = matchesClosest(ev.target, '.salim-pkg-cta');
        if (btn) triggerCtaPress(btn);
      },
      { passive: true, capture: true }
    );

    document.addEventListener(
      'pointerup',
      function (ev) {
        var btn = matchesClosest(ev.target, '.salim-pkg-cta');
        releaseCtaPress(btn, false);
      },
      { passive: true, capture: true }
    );

    document.addEventListener(
      'pointercancel',
      function () {
        releaseCtaPress(null, true);
      },
      { passive: true, capture: true }
    );
  } else {
    document.addEventListener(
      'touchstart',
      function (ev) {
        var btn = matchesClosest(ev.target, '.salim-pkg-cta');
        if (btn) triggerCtaPress(btn);
      },
      { passive: true, capture: true }
    );
    document.addEventListener(
      'touchend',
      function (ev) {
        var btn = matchesClosest(ev.target, '.salim-pkg-cta');
        releaseCtaPress(btn, false);
      },
      { passive: true, capture: true }
    );
    document.addEventListener(
      'touchcancel',
      function () {
        releaseCtaPress(null, true);
      },
      { passive: true, capture: true }
    );
    document.addEventListener(
      'mousedown',
      function (ev) {
        var btn = matchesClosest(ev.target, '.salim-pkg-cta');
        if (btn) triggerCtaPress(btn);
      },
      true
    );
    document.addEventListener(
      'mouseup',
      function (ev) {
        var btn = matchesClosest(ev.target, '.salim-pkg-cta');
        releaseCtaPress(btn, false);
      },
      true
    );
  }

  /* ------------------------------------------------------------------------
   * 3. ELECTRIC GOLDEN ARCS, FLASHES & SPARKS ENGINE (VISIBLE CARDS ONLY)
   * ------------------------------------------------------------------------ */
  var MAX_SPARKS = 10;
  var JITTER_COUNT = 32;
  var visibleCards = new Set();
  var observedCards = typeof WeakSet === 'function' ? new WeakSet() : null;
  var observedGrid = null;
  var cardObserver = null;
  var gridResizeObserver = null;
  var stagePresent = false;
  var rafLoopId = 0;
  var lastFrameTs = 0;
  var nextTransferAt = 0;

  function createSlotState() {
    var canvas = document.createElement('canvas');
    canvas.className = 'salim-electric-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    var ctx = null;
    try {
      ctx = canvas.getContext('2d', { alpha: true }) || canvas.getContext('2d');
    } catch (_) {
      ctx = canvas.getContext ? canvas.getContext('2d') : null;
    }

    var sparks = [];
    for (var i = 0; i < MAX_SPARKS; i++) {
      sparks.push({
        active: false,
        x: 0,
        y: 0,
        prevX: 0,
        prevY: 0,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 1,
        size: 1.5
      });
    }

    return {
      canvas: canvas,
      ctx: ctx,
      card: null,
      w: 0,
      h: 0,
      dpr: 1,
      lastSizeCheckAt: 0,
      opacity: 0,
      targetOpacity: 0,
      phase: Math.random() * 100,
      arcOffsetA: Math.random(),
      arcOffsetB: (Math.random() + 0.45) % 1,
      arcSpeedA: 0.08 + Math.random() * 0.045,
      arcSpeedB: -(0.06 + Math.random() * 0.04),
      lastJitterAt: 0,
      jitterCurr: new Float32Array(JITTER_COUNT),
      jitterTarget: new Float32Array(JITTER_COUNT),
      flashAmp: 0.35,
      flashTarget: 0.45,
      sparks: sparks
    };
  }

  var slotPrimary = createSlotState();
  var slotFading = createSlotState();

  function refreshJitterTargets(slot) {
    for (var i = 0; i < JITTER_COUNT; i++) {
      slot.jitterTarget[i] = (Math.random() - 0.5) * 2;
    }
    slot.flashTarget = Math.random() < 0.34 ? 0.68 + Math.random() * 0.32 : 0.18 + Math.random() * 0.28;
  }
  refreshJitterTargets(slotPrimary);
  refreshJitterTargets(slotFading);
  slotPrimary.jitterCurr.set(slotPrimary.jitterTarget);
  slotFading.jitterCurr.set(slotFading.jitterTarget);

  function syncCanvasSize(slot) {
    if (!slot.card) return false;
    var cw = slot.card.offsetWidth;
    var ch = slot.card.offsetHeight;
    if (!cw || !ch) return false;

    var pad = 10; // matches CSS .salim-ch-electric-slot { inset: -10px }
    var totalW = cw + pad * 2;
    var totalH = ch + pad * 2;
    var maxDpr = perfTier === 'ultra' ? 2.0 : (perfTier === 'compat' ? 1.0 : 1.25);
    var dpr = Math.min(window.devicePixelRatio || 1, maxDpr);

    if (slot.w !== totalW || slot.h !== totalH || slot.dpr !== dpr) {
      slot.w = totalW;
      slot.h = totalH;
      slot.dpr = dpr;
      slot.canvas.width = Math.round(totalW * dpr);
      slot.canvas.height = Math.round(totalH * dpr);
      if (slot.ctx) {
        slot.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
    return true;
  }

  function detachSlot(slot) {
    if (slot.card) {
      slot.card.classList.remove('salim-ch-card-energized');
    }
    if (slot.canvas.parentNode) {
      slot.canvas.parentNode.removeChild(slot.canvas);
    }
    if (slot.ctx && slot.w && slot.h) {
      slot.ctx.clearRect(0, 0, slot.w, slot.h);
    }
    slot.card = null;
    slot.opacity = 0;
    slot.targetOpacity = 0;
    for (var i = 0; i < slot.sparks.length; i++) {
      slot.sparks[i].active = false;
    }
  }

  function attachSlot(slot, card) {
    if (!isNodeConnected(card)) return false;
    var host = card.querySelector('.salim-ch-electric-slot') || card;
    slot.card = card;
    slot.opacity = 0.08;
    slot.targetOpacity = 1;
    slot.arcOffsetA = Math.random();
    slot.arcOffsetB = (slot.arcOffsetA + 0.42 + Math.random() * 0.2) % 1;
    refreshJitterTargets(slot);
    slot.jitterCurr.set(slot.jitterTarget);
    if (slot.canvas.parentNode !== host) {
      host.appendChild(slot.canvas);
    }
    card.classList.add('salim-ch-card-energized');
    syncCanvasSize(slot);
    return true;
  }

  // Maps normalized perimeter t in [0, 1) to (x, y, nx, ny) on a rounded rectangle
  function sampleRoundedRectPerimeter(t, x, y, w, h, r, out) {
    t = ((t % 1) + 1) % 1;
    var straightW = Math.max(0, w - 2 * r);
    var straightH = Math.max(0, h - 2 * r);
    var arcLen = 0.5 * Math.PI * r;
    var perim = 2 * straightW + 2 * straightH + 4 * arcLen;
    if (perim <= 0) {
      out.x = x;
      out.y = y;
      out.nx = 0;
      out.ny = -1;
      return;
    }
    var d = t * perim;

    if (d < straightW) {
      out.x = x + r + d;
      out.y = y;
      out.nx = 0;
      out.ny = -1;
      return;
    }
    d -= straightW;

    if (d < arcLen) {
      var a = -Math.PI / 2 + (d / arcLen) * (Math.PI / 2);
      var cos = Math.cos(a);
      var sin = Math.sin(a);
      out.x = x + w - r + cos * r;
      out.y = y + r + sin * r;
      out.nx = cos;
      out.ny = sin;
      return;
    }
    d -= arcLen;

    if (d < straightH) {
      out.x = x + w;
      out.y = y + r + d;
      out.nx = 1;
      out.ny = 0;
      return;
    }
    d -= straightH;

    if (d < arcLen) {
      var a2 = (d / arcLen) * (Math.PI / 2);
      var cos2 = Math.cos(a2);
      var sin2 = Math.sin(a2);
      out.x = x + w - r + cos2 * r;
      out.y = y + h - r + sin2 * r;
      out.nx = cos2;
      out.ny = sin2;
      return;
    }
    d -= arcLen;

    if (d < straightW) {
      out.x = x + w - r - d;
      out.y = y + h;
      out.nx = 0;
      out.ny = 1;
      return;
    }
    d -= straightW;

    if (d < arcLen) {
      var a3 = Math.PI / 2 + (d / arcLen) * (Math.PI / 2);
      var cos3 = Math.cos(a3);
      var sin3 = Math.sin(a3);
      out.x = x + r + cos3 * r;
      out.y = y + h - r + sin3 * r;
      out.nx = cos3;
      out.ny = sin3;
      return;
    }
    d -= arcLen;

    if (d < straightH) {
      out.x = x;
      out.y = y + h - r - d;
      out.nx = -1;
      out.ny = 0;
      return;
    }
    d -= straightH;

    var a4 = Math.PI + (d / arcLen) * (Math.PI / 2);
    var cos4 = Math.cos(a4);
    var sin4 = Math.sin(a4);
    out.x = x + r + cos4 * r;
    out.y = y + r + sin4 * r;
    out.nx = cos4;
    out.ny = sin4;
  }

  var ptScratch = { x: 0, y: 0, nx: 0, ny: 0 };
  var boltPtsX = new Float32Array(28);
  var boltPtsY = new Float32Array(28);

  function getMaxSparkCount() {
    if (perfTier === 'ultra') return MAX_SPARKS;
    if (perfTier === 'compat') return 4;
    return 6;
  }

  function emitSparkFromPoint(slot, x, y, nx, ny, boost) {
    var maxSparkCount = getMaxSparkCount();
    for (var sIdx = 0; sIdx < maxSparkCount; sIdx++) {
      var sp = slot.sparks[sIdx];
      if (!sp.active) {
        sp.active = true;
        sp.x = x;
        sp.y = y;
        sp.prevX = x;
        sp.prevY = y;
        var outSpeed = (14 + Math.random() * 24) * (boost ? 1.25 : 1);
        var tangentSign = Math.random() < 0.5 ? -1 : 1;
        var tangentSpeed = tangentSign * (8 + Math.random() * 16);
        sp.vx = nx * outSpeed - ny * tangentSpeed + (Math.random() - 0.5) * 10;
        sp.vy = ny * outSpeed + nx * tangentSpeed + (Math.random() - 0.5) * 10;
        sp.life = 0;
        sp.maxLife = 0.28 + Math.random() * 0.28;
        sp.size = 1.0 + Math.random() * 1.35;
        break;
      }
    }
  }

  function drawElectricArcSpan(ctx, slot, rectX, rectY, rectW, rectH, radius, startT, spanT, seedOffset, alpha, spawnSparks) {
    var steps = perfTier === 'ultra' ? 22 : (perfTier === 'compat' ? 12 : 16);
    var jitterMag = perfTier === 'compat' ? 4.2 : 5.0;
    var headNx = 0;
    var headNy = -1;

    for (var i = 0; i <= steps; i++) {
      var frac = i / steps;
      var t = startT + frac * spanT;
      sampleRoundedRectPerimeter(t, rectX, rectY, rectW, rectH, radius, ptScratch);

      var edgeFade = Math.sin(frac * Math.PI);
      var seed = slot.jitterCurr[(i + seedOffset) % JITTER_COUNT];
      var disp = seed * jitterMag * (0.22 + 0.78 * edgeFade);

      boltPtsX[i] = ptScratch.x + ptScratch.nx * disp;
      boltPtsY[i] = ptScratch.y + ptScratch.ny * disp;

      if (i === steps) {
        headNx = ptScratch.nx;
        headNy = ptScratch.ny;
      }

      if (spawnSparks && i > 1 && i < steps - 1) {
        var sparkChance = perfTier === 'ultra' ? 0.055 : (perfTier === 'compat' ? 0.025 : 0.032);
        if (Math.random() < sparkChance) {
          emitSparkFromPoint(slot, boltPtsX[i], boltPtsY[i], ptScratch.nx, ptScratch.ny, slot.flashAmp > 0.6);
        }
      }
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(boltPtsX[0], boltPtsY[0]);
    for (var p1 = 1; p1 <= steps; p1++) {
      ctx.lineTo(boltPtsX[p1], boltPtsY[p1]);
    }

    if (perfTier !== 'compat') {
      // Pass 1: Soft outer amber aura
      ctx.strokeStyle = 'rgba(245, 158, 11, ' + (0.22 * alpha).toFixed(3) + ')';
      ctx.lineWidth = 6.5;
      ctx.stroke();
    }

    // Pass 2: Rich metallic gold arc body
    ctx.strokeStyle = 'rgba(251, 191, 36, ' + (0.76 * alpha).toFixed(3) + ')';
    ctx.lineWidth = perfTier === 'compat' ? 3.2 : 2.35;
    ctx.stroke();

    // Pass 3: Bright white-gold electric core
    ctx.strokeStyle = 'rgba(254, 249, 195, ' + (0.96 * alpha).toFixed(3) + ')';
    ctx.lineWidth = 1.15;
    ctx.stroke();

    // Traveling golden electric flash node at the moving head of the arc
    var hx = boltPtsX[steps];
    var hy = boltPtsY[steps];
    var flashScale = 0.7 + 0.55 * slot.flashAmp;
    ctx.fillStyle = 'rgba(251, 191, 36, ' + (0.36 * alpha).toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(hx, hy, 5.0 * flashScale, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(254, 249, 195, ' + (0.94 * alpha).toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(hx, hy, 1.9 * flashScale, 0, Math.PI * 2);
    ctx.fill();

    if (spawnSparks && slot.flashAmp > 0.62 && Math.random() < (perfTier === 'compat' ? 0.16 : 0.24)) {
      emitSparkFromPoint(slot, hx, hy, headNx, headNy, true);
    }

    // Organic fork filament during higher flash pulses (balanced & ultra)
    if (perfTier !== 'compat' && alpha > 0.42 && slot.flashAmp > 0.52) {
      var forkIdx = Math.floor(steps * 0.48);
      var fx = boltPtsX[forkIdx];
      var fy = boltPtsY[forkIdx];
      var ang =
        Math.atan2(boltPtsY[forkIdx + 1] - fy, boltPtsX[forkIdx + 1] - fx) +
        (seedOffset % 2 === 0 ? 0.62 : -0.62);
      var midX = fx + Math.cos(ang) * 7.2;
      var midY = fy + Math.sin(ang) * 7.2;
      var endX = midX + Math.cos(ang + (Math.random() - 0.5) * 0.6) * 6.0;
      var endY = midY + Math.sin(ang + (Math.random() - 0.5) * 0.6) * 6.0;

      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(midX, midY);
      ctx.lineTo(endX, endY);
      ctx.strokeStyle = 'rgba(253, 224, 71, ' + (0.68 * alpha).toFixed(3) + ')';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  function renderSlot(slot, dtSec, now) {
    if (!slot.card || !slot.ctx) return false;
    if (!isNodeConnected(slot.card)) {
      detachSlot(slot);
      return false;
    }

    // Periodic size verification fallback when ResizeObserver is absent (Chromium < 64 / Android 7.0)
    if (!slot.w || !slot.h || (!gridResizeObserver && now - slot.lastSizeCheckAt > 600)) {
      slot.lastSizeCheckAt = now;
      syncCanvasSize(slot);
    }

    var opacityRate = slot.targetOpacity > slot.opacity ? 3.8 : 2.3;
    slot.opacity += (slot.targetOpacity - slot.opacity) * Math.min(1, dtSec * opacityRate);

    if (slot.targetOpacity === 0 && slot.opacity < 0.025) {
      detachSlot(slot);
      return false;
    }

    var ctx = slot.ctx;
    var w = slot.w;
    var h = slot.h;
    if (!w || !h) return true;

    ctx.clearRect(0, 0, w, h);

    if (now - slot.lastJitterAt > 95) {
      slot.lastJitterAt = now;
      refreshJitterTargets(slot);
    }

    var lerpAmt = Math.min(1, dtSec * 14);
    for (var j = 0; j < JITTER_COUNT; j++) {
      slot.jitterCurr[j] += (slot.jitterTarget[j] - slot.jitterCurr[j]) * lerpAmt;
    }
    slot.flashAmp += (slot.flashTarget - slot.flashAmp) * Math.min(1, dtSec * 9);

    var tSec = now * 0.001;
    var driftA = 0.72 + 0.45 * Math.sin(tSec * 1.45 + slot.phase);
    var driftB = 0.72 + 0.45 * Math.cos(tSec * 1.18 + slot.phase * 1.3);
    slot.arcOffsetA = (slot.arcOffsetA + slot.arcSpeedA * driftA * dtSec + 1) % 1;
    slot.arcOffsetB = (slot.arcOffsetB + slot.arcSpeedB * driftB * dtSec + 1) % 1;

    var pad = 10;
    var rectX = pad;
    var rectY = pad;
    var rectW = w - pad * 2;
    var rectH = h - pad * 2;
    var radius = 24;

    var flicker = 0.74 + 0.26 * slot.flashAmp;
    var alpha = Math.max(0, Math.min(1, slot.opacity * flicker));
    var allowSparks = slot.targetOpacity > 0.5;

    drawElectricArcSpan(ctx, slot, rectX, rectY, rectW, rectH, radius, slot.arcOffsetA, 0.34, 0, alpha, allowSparks);
    drawElectricArcSpan(ctx, slot, rectX, rectY, rectW, rectH, radius, slot.arcOffsetB, 0.26, 11, alpha * 0.88, allowSparks);

    if (perfTier === 'ultra' && slot.flashAmp > 0.62) {
      drawElectricArcSpan(
        ctx,
        slot,
        rectX,
        rectY,
        rectW,
        rectH,
        radius,
        (slot.arcOffsetA + 0.62) % 1,
        0.16,
        21,
        alpha * 0.72,
        false
      );
    }

    var maxSparkCount = getMaxSparkCount();
    for (var i = 0; i < maxSparkCount; i++) {
      var sp = slot.sparks[i];
      if (!sp.active) continue;
      sp.life += dtSec;
      if (sp.life >= sp.maxLife) {
        sp.active = false;
        continue;
      }
      sp.prevX = sp.x;
      sp.prevY = sp.y;
      sp.x += sp.vx * dtSec;
      sp.y += sp.vy * dtSec;
      sp.vx *= 0.93;
      sp.vy *= 0.93;

      var lifeRatio = 1 - sp.life / sp.maxLife;
      var sAlpha = lifeRatio * slot.opacity;

      ctx.strokeStyle = 'rgba(253, 224, 71, ' + (0.55 * sAlpha).toFixed(3) + ')';
      ctx.lineWidth = sp.size * 0.85;
      ctx.beginPath();
      ctx.moveTo(sp.prevX, sp.prevY);
      ctx.lineTo(sp.x, sp.y);
      ctx.stroke();

      ctx.fillStyle = 'rgba(251, 191, 36, ' + (0.42 * sAlpha).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.size * 2.1, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(254, 249, 195, ' + (0.96 * sAlpha).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.size * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }

    return true;
  }

  function pickNextVisibleCard() {
    var candidates = [];
    visibleCards.forEach(function (card) {
      if (isNodeConnected(card)) {
        candidates.push(card);
      } else {
        visibleCards.delete(card);
      }
    });

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    var filtered = candidates.filter(function (c) {
      return c !== slotPrimary.card;
    });
    var pool = filtered.length > 0 ? filtered : candidates;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  var TRANSFER_MIN_MS = 2200;
  var TRANSFER_MAX_MS = 4300;
  var TARGET_FPS_ULTRA = 60;
  var TARGET_FPS_BALANCED = 36;
  var TARGET_FPS_COMPAT = 24;

  function nextRandomTransferDelay() {
    return TRANSFER_MIN_MS + Math.random() * (TRANSFER_MAX_MS - TRANSFER_MIN_MS);
  }

  function getTargetFps() {
    if (perfTier === 'ultra') return TARGET_FPS_ULTRA;
    if (perfTier === 'compat') return TARGET_FPS_COMPAT;
    return TARGET_FPS_BALANCED;
  }

  function transferElectricEffect(now) {
    var nextCard = pickNextVisibleCard();
    if (!nextCard) {
      if (slotPrimary.card) {
        slotPrimary.card.classList.remove('salim-ch-card-energized');
        slotPrimary.targetOpacity = 0;
      }
      nextTransferAt = now + 900;
      return;
    }

    if (nextCard === slotPrimary.card) {
      nextTransferAt = now + nextRandomTransferDelay();
      return;
    }

    if (slotPrimary.card && isNodeConnected(slotPrimary.card)) {
      detachSlot(slotFading);
      var temp = slotFading;
      slotFading = slotPrimary;
      slotPrimary = temp;
      slotFading.card.classList.remove('salim-ch-card-energized');
      slotFading.targetOpacity = 0;
    } else {
      detachSlot(slotPrimary);
    }

    attachSlot(slotPrimary, nextCard);
    nextTransferAt = now + nextRandomTransferDelay();
  }

  function stopElectricLoop() {
    if (rafLoopId) {
      cancelRaf(rafLoopId);
      rafLoopId = 0;
    }
    detachSlot(slotPrimary);
    detachSlot(slotFading);
  }

  function electricTick(now) {
    rafLoopId = 0;
    if (!stagePresent || isDocHidden()) {
      stopElectricLoop();
      return;
    }

    if (slotFading.card && !visibleCards.has(slotFading.card)) {
      detachSlot(slotFading);
    }
    if (slotPrimary.card && !visibleCards.has(slotPrimary.card)) {
      slotPrimary.card.classList.remove('salim-ch-card-energized');
      if (visibleCards.size === 0) {
        detachSlot(slotPrimary);
      } else {
        transferElectricEffect(now);
      }
    }

    if (visibleCards.size === 0 && !slotPrimary.card && !slotFading.card) {
      lastFrameTs = 0;
      return;
    }

    var targetFps = getTargetFps();
    var minFrameMs = 1000 / Math.max(20, Math.min(60, targetFps));
    if (!lastFrameTs || now - lastFrameTs >= minFrameMs - 0.5) {
      var dtSec = lastFrameTs ? Math.min(0.08, (now - lastFrameTs) / 1000) : minFrameMs / 1000;
      lastFrameTs = now;

      if (!slotPrimary.card && visibleCards.size > 0) {
        transferElectricEffect(now);
      } else if (now >= nextTransferAt) {
        transferElectricEffect(now);
      }

      renderSlot(slotFading, dtSec, now);
      renderSlot(slotPrimary, dtSec, now);
    }

    if (visibleCards.size > 0 || slotPrimary.card || slotFading.card) {
      rafLoopId = requestRaf(electricTick);
    }
  }

  function startElectricEngine() {
    if (!stagePresent || isDocHidden()) return;

    if (!rafLoopId && (visibleCards.size > 0 || slotPrimary.card || slotFading.card)) {
      lastFrameTs = 0;
      if (!nextTransferAt) {
        nextTransferAt = nowMs() + 240;
      }
      rafLoopId = requestRaf(electricTick);
    }
  }

  function probeVisibleCardsByRect() {
    var grid = document.querySelector('.salim-channels-grid');
    if (!grid) return;
    var cards = grid.querySelectorAll('.salim-ch-card[data-salim-ch-id]');
    var viewH = window.innerHeight || docEl.clientHeight || 800;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var rect = card.getBoundingClientRect ? card.getBoundingClientRect() : null;
      if (!rect || (rect.width > 0 && rect.bottom > 0 && rect.top < viewH)) {
        visibleCards.add(card);
      } else {
        visibleCards.delete(card);
      }
    }
    if (visibleCards.size > 0 && stagePresent && !isDocHidden()) {
      startElectricEngine();
    }
  }

  function observeVisibleChannelCards() {
    var grid = document.querySelector('.salim-channels-grid');
    if (!grid) {
      visibleCards.clear();
      observedGrid = null;
      return;
    }

    if (typeof IntersectionObserver === 'function' && !cardObserver) {
      cardObserver = new IntersectionObserver(
        function (entries) {
          for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry.isIntersecting) {
              visibleCards.add(entry.target);
            } else {
              visibleCards.delete(entry.target);
            }
          }
          if (stagePresent && !isDocHidden()) {
            if (visibleCards.size > 0) {
              startElectricEngine();
            } else if (slotPrimary.card && !visibleCards.has(slotPrimary.card)) {
              detachSlot(slotPrimary);
            }
          }
        },
        { threshold: 0.1 }
      );
    }

    visibleCards.forEach(function (c) {
      if (!isNodeConnected(c)) {
        visibleCards.delete(c);
      }
    });

    var cards = grid.querySelectorAll('.salim-ch-card[data-salim-ch-id]');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (cardObserver) {
        if (!observedCards || !observedCards.has(card)) {
          if (observedCards) observedCards.add(card);
          cardObserver.observe(card);
        }
      } else {
        visibleCards.add(card);
      }
    }

    // Immediate rect fallback if IO hasn't emitted yet or isn't supported
    if (visibleCards.size === 0 && cards.length > 0) {
      probeVisibleCardsByRect();
    }

    if (!gridResizeObserver && typeof ResizeObserver === 'function') {
      gridResizeObserver = new ResizeObserver(function () {
        if (slotPrimary.card) syncCanvasSize(slotPrimary);
        if (slotFading.card) syncCanvasSize(slotFading);
      });
    }
    if (gridResizeObserver && observedGrid !== grid) {
      gridResizeObserver.disconnect();
      gridResizeObserver.observe(grid);
      observedGrid = grid;
    }
  }

  /* ------------------------------------------------------------------------
   * 4. LIFECYCLE SYNC (MOUNT / UNMOUNT / TAB CLASS CHANGES / VISIBILITY)
   * ------------------------------------------------------------------------ */
  var syncScheduled = false;
  var postMountTimer = 0;

  function syncDomState() {
    syncScheduled = false;
    var stage = document.querySelector('.salim-channels-stage');
    var nextPresent = Boolean(stage);

    if (nextPresent !== stagePresent) {
      stagePresent = nextPresent;
      if (!stagePresent) {
        visibleCards.clear();
        observedGrid = null;
        observedCards = typeof WeakSet === 'function' ? new WeakSet() : null;
        if (cardObserver) cardObserver.disconnect();
        if (gridResizeObserver) gridResizeObserver.disconnect();
        if (postMountTimer) {
          clearTimeout(postMountTimer);
          postMountTimer = 0;
        }
        stopElectricLoop();
      } else {
        // Re-probe slightly after mount on slower CPUs (MT6737)
        if (postMountTimer) clearTimeout(postMountTimer);
        postMountTimer = setTimeout(function () {
          postMountTimer = 0;
          if (stagePresent) {
            observeVisibleChannelCards();
            startElectricEngine();
          }
        }, 80);
      }
    }

    if (stagePresent) {
      observeVisibleChannelCards();
      startElectricEngine();
    }

    scheduleNavUpdate(false);
  }

  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    requestRaf(syncDomState);
  }

  function isOwnFxMutation(mut) {
    var t = mut.target;
    if (!t) return false;
    if (t.classList) {
      if (
        t.classList.contains('salim-electric-canvas') ||
        t.classList.contains('salim-nav-traveler') ||
        t.classList.contains('salim-ch-electric-slot')
      ) {
        return true;
      }
    }
    if (mut.type === 'attributes') {
      if (mut.attributeName === 'style' || mut.attributeName === 'width' || mut.attributeName === 'height') {
        return true;
      }
      if (mut.attributeName === 'class' && t.classList && !t.classList.contains('salim-nav-tab')) {
        return true;
      }
    }
    return false;
  }

  var rootObserver = typeof MutationObserver === 'function'
    ? new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          if (!isOwnFxMutation(mutations[i])) {
            scheduleSync();
            return;
          }
        }
      })
    : null;

  function init() {
    var rootEl = document.getElementById('root') || document.body;
    if (rootEl && rootObserver) {
      rootObserver.observe(rootEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
      });
    }
    syncDomState();
    scheduleNavUpdate(true);
  }

  document.addEventListener('visibilitychange', function () {
    if (isDocHidden()) {
      stopElectricLoop();
    } else if (stagePresent) {
      observeVisibleChannelCards();
      startElectricEngine();
    }
  });

  if (!cardObserver) {
    window.addEventListener(
      'scroll',
      function () {
        if (stagePresent && !isDocHidden()) probeVisibleCardsByRect();
      },
      { passive: true }
    );
  }

  if (typeof window !== 'undefined') {
    window.__SalimChannelsFx = {
      getTier: function () {
        return perfTier;
      },
      getTargetFps: getTargetFps,
      getVisibleCount: function () {
        return visibleCards.size;
      },
      isRunning: function () {
        return Boolean(rafLoopId);
      },
      getActiveCardId: function () {
        return slotPrimary.card ? slotPrimary.card.getAttribute('data-salim-ch-id') : null;
      },
      getActiveNavTab: function () {
        return lastNavTabKey;
      },
      recomputeTier: function () {
        applyPerfTier(computePerfTier());
        return perfTier;
      },
      forceSync: syncDomState,
      getDiagnostics: function () {
        return {
          tier: perfTier,
          targetFps: getTargetFps(),
          stagePresent: stagePresent,
          visibleCards: visibleCards.size,
          running: Boolean(rafLoopId),
          activeCardId: slotPrimary.card ? slotPrimary.card.getAttribute('data-salim-ch-id') : null,
          activeNavTab: lastNavTabKey,
          canvasW: slotPrimary.w,
          canvasH: slotPrimary.h,
          dpr: slotPrimary.dpr,
          deviceProfile: window.__samiDeviceProfile || null
        };
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
