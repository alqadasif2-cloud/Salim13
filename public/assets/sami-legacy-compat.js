(function() {
  try {
    var docEl = document.documentElement;
    var ua = navigator.userAgent || '';

    function safeCssSupports(prop, val) {
      if (!window.CSS || typeof CSS.supports !== 'function') return false;
      try {
        return val !== undefined ? CSS.supports(prop, val) : CSS.supports(prop);
      } catch (e) {
        return false;
      }
    }

    // 1. Read native Android bridge hardware metrics if running in Salim APK
    var nativeCaps = null;
    try {
      if (window.SamiBridge && typeof window.SamiBridge.getDeviceCapabilities === 'function') {
        var rawCaps = window.SamiBridge.getDeviceCapabilities();
        if (rawCaps) nativeCaps = JSON.parse(rawCaps);
      }
    } catch (e) {}

    // 2. Detect Android version & Chromium WebView major version
    var isAndroid = /Android/i.test(ua) || Boolean(nativeCaps && nativeCaps.sdkInt);
    var androidVer = 0;
    var androidMatch = ua.match(/Android\s+([0-9\.]+)/i);
    if (androidMatch && androidMatch[1]) {
      androidVer = parseFloat(androidMatch[1]) || 0;
    } else if (nativeCaps && nativeCaps.androidRelease) {
      androidVer = parseFloat(nativeCaps.androidRelease) || 0;
    }

    var chromeVer = 0;
    var wvVerSource = (nativeCaps && nativeCaps.webViewVersion) ? String(nativeCaps.webViewVersion) : '';
    if (wvVerSource) {
      chromeVer = parseInt(wvVerSource.split('.')[0], 10) || 0;
    }
    if (!chromeVer) {
      var chromeMatch = ua.match(/(?:Chrome|CriOS|Version)\/([0-9]+)/i);
      if (chromeMatch && chromeMatch[1]) {
        chromeVer = parseInt(chromeMatch[1], 10) || 0;
      }
    }

    // 3. Detect GPU via WebGL (without retaining WebGL context)
    var gpuVendor = '';
    var gpuRenderer = '';
    var isSoftwareGpu = false;
    try {
      var probeCanvas = document.createElement('canvas');
      probeCanvas.width = 1;
      probeCanvas.height = 1;
      var gl = probeCanvas.getContext('webgl') || probeCanvas.getContext('experimental-webgl');
      if (gl) {
        var dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          gpuVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '');
          gpuRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
        } else {
          gpuRenderer = String(gl.getParameter(gl.RENDERER) || '');
        }
        var loseExt = gl.getExtension('WEBGL_lose_context');
        if (loseExt && typeof loseExt.loseContext === 'function') {
          loseExt.loseContext();
        }
      }
    } catch (e) {}

    var gpuLower = gpuRenderer.toLowerCase();
    isSoftwareGpu = !gpuRenderer || gpuLower.indexOf('swiftshader') !== -1 || gpuLower.indexOf('llvmpipe') !== -1 || gpuLower.indexOf('software') !== -1;
    var isLegacyMaliOrLowGpu =
      gpuLower.indexOf('mali-t') !== -1 ||
      gpuLower.indexOf('mali-4') !== -1 ||
      gpuLower.indexOf('mali-g52') !== -1 ||
      gpuLower.indexOf('mali-g51') !== -1 ||
      gpuLower.indexOf('adreno (tm) 3') !== -1 ||
      gpuLower.indexOf('adreno (tm) 4') !== -1 ||
      gpuLower.indexOf('powervr') !== -1;

    // 4. Memory, CPU cores, and refresh rate
    var totalRamMb = nativeCaps && nativeCaps.totalRamMb ? Number(nativeCaps.totalRamMb) : 0;
    var deviceMemoryGb = Number(navigator.deviceMemory) || (totalRamMb ? Math.round((totalRamMb / 1024) * 10) / 10 : 0);
    var cpuCores = (nativeCaps && nativeCaps.cpuCores) ? Number(nativeCaps.cpuCores) : (Number(navigator.hardwareConcurrency) || 4);
    var refreshRateHz = (nativeCaps && nativeCaps.refreshRateHz) ? Number(nativeCaps.refreshRateHz) : 60;
    var isLowRam = Boolean(nativeCaps && nativeCaps.isLowRamDevice) ||
      (totalRamMb > 0 && totalRamMb <= 3100) ||
      (deviceMemoryGb > 0 && deviceMemoryGb <= 3);

    // 5. CSS capability detection
    var supportsBackdrop = safeCssSupports('backdrop-filter', 'blur(10px)') || safeCssSupports('-webkit-backdrop-filter', 'blur(10px)');
    var supportsOklch = safeCssSupports('color', 'oklch(50% 0.1 100)');
    var supportsTranslate = safeCssSupports('translate', '0px 0px');
    var supportsScale = safeCssSupports('scale', '1');
    var supportsRotate = safeCssSupports('rotate', '1deg');
    var supportsInset = safeCssSupports('inset', '0px');
    var supportsWhere = safeCssSupports('selector(:where(*))');
    var supportsMask = safeCssSupports('mask-image', 'linear-gradient(#000, #000)') || safeCssSupports('-webkit-mask-image', 'linear-gradient(#000, #000)');
    var supportsAtLayer = typeof window.CSSLayerBlockRule === 'function';
    var supportsConic = safeCssSupports('background-image', 'conic-gradient(from 0deg, #000, #fff)');

    var isLegacyAndroid = isAndroid && (
      androidVer < 12 ||
      (chromeVer > 0 && chromeVer < 111) ||
      !supportsBackdrop ||
      !supportsOklch ||
      !supportsAtLayer
    );

    // Constrain heavy per-frame blur filters on 2-3GB RAM / Mali-T720 / Mali-G52 / legacy Android
    // WITHOUT ever disabling CSS or JS animations.
    var needsGpuSafeBlurReduction = isLowRam || isLegacyMaliOrLowGpu || !supportsBackdrop || (isAndroid && androidVer > 0 && androidVer < 10);

    var profile = {
      isAndroid: isAndroid,
      androidVer: androidVer,
      chromeVer: chromeVer,
      totalRamMb: totalRamMb,
      deviceMemoryGb: deviceMemoryGb,
      cpuCores: cpuCores,
      refreshRateHz: refreshRateHz,
      isLowRam: isLowRam,
      gpuVendor: gpuVendor,
      gpuRenderer: gpuRenderer,
      isSoftwareGpu: isSoftwareGpu,
      isLegacyMaliOrLowGpu: isLegacyMaliOrLowGpu,
      needsGpuSafeBlurReduction: needsGpuSafeBlurReduction,
      isLegacyAndroid: isLegacyAndroid,
      css: {
        atLayer: supportsAtLayer,
        backdropFilter: supportsBackdrop,
        oklch: supportsOklch,
        translateProp: supportsTranslate,
        scaleProp: supportsScale,
        rotateProp: supportsRotate,
        insetProp: supportsInset,
        whereSelector: supportsWhere,
        maskImage: supportsMask,
        conicGradient: supportsConic
      }
    };

    window.__samiDeviceProfile = profile;
    window.__samiIsLegacyAndroid = isLegacyAndroid;

    if (!supportsBackdrop) docEl.classList.add('sami-no-backdrop');
    if (!supportsOklch) docEl.classList.add('sami-no-oklch');
    if (!supportsTranslate || !supportsScale || !supportsRotate) docEl.classList.add('sami-no-css-translate');
    if (!supportsMask) docEl.classList.add('sami-no-css-mask');
    if (!supportsAtLayer) docEl.classList.add('sami-no-css-layer');
    if (!supportsConic) docEl.classList.add('sami-no-conic');
    if (needsGpuSafeBlurReduction) docEl.classList.add('sami-gpu-safe');

    if (isLegacyAndroid) {
      docEl.classList.add('sami-legacy-android');
      if (document.body) document.body.classList.add('sami-legacy-android');
    }

    if (isAndroid) {
      docEl.classList.add('sami-android-webview');
      if (document.body) document.body.classList.add('sami-android-webview');
    }

    // 6. Tailwind v4 @layer / :where() / :is() Unwrapper for Android 7.0-11 WebViews (Chromium < 99)
    function findMatchingDelim(str, openIdx, openCh, closeCh) {
      var depth = 0;
      var inStr = '';
      for (var k = openIdx; k < str.length; k++) {
        var ch = str.charAt(k);
        if (ch === '\\') {
          k++;
          continue;
        }
        if (inStr) {
          if (ch === inStr) inStr = '';
          continue;
        }
        if (ch === '/' && str.charAt(k + 1) === '*') {
          var commentEnd = str.indexOf('*/', k + 2);
          if (commentEnd === -1) return -1;
          k = commentEnd + 1;
          continue;
        }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === openCh) depth++;
        else if (ch === closeCh) {
          depth--;
          if (depth === 0) return k;
        }
      }
      return -1;
    }

    function stripBalancedPseudo(str, token) {
      var res = str;
      var pos = 0;
      while (true) {
        var idx = res.indexOf(token, pos);
        if (idx === -1) break;
        var openIdx = idx + token.length - 1;
        var closeIdx = findMatchingDelim(res, openIdx, '(', ')');
        if (closeIdx === -1) {
          pos = idx + token.length;
          continue;
        }
        var inner = res.slice(openIdx + 1, closeIdx);
        res = res.slice(0, idx) + inner + res.slice(closeIdx + 1);
        pos = idx;
      }
      return res;
    }

    function unwrapLegacyCss(cssText) {
      if (!cssText) return '';
      var out = [];
      var i = 0;
      var n = cssText.length;

      while (i < n) {
        if (cssText.charAt(i) === '/' && cssText.charAt(i + 1) === '*') {
          var cEnd = cssText.indexOf('*/', i + 2);
          if (cEnd === -1) break;
          i = cEnd + 2;
          continue;
        }
        if (cssText.substr(i, 6) === '@layer') {
          var braceIdx = cssText.indexOf('{', i);
          var semiIdx = cssText.indexOf(';', i);
          if (semiIdx !== -1 && (braceIdx === -1 || semiIdx < braceIdx)) {
            i = semiIdx + 1;
            continue;
          }
          if (braceIdx !== -1) {
            var header = cssText.slice(i, braceIdx);
            var endIdx = findMatchingDelim(cssText, braceIdx, '{', '}');
            if (endIdx !== -1) {
              if (header.indexOf('properties') === -1) {
                out.push(unwrapLegacyCss(cssText.slice(braceIdx + 1, endIdx)));
              }
              i = endIdx + 1;
              continue;
            }
          }
        }
        if (cssText.substr(i, 9) === '@property') {
          var pBrace = cssText.indexOf('{', i);
          if (pBrace !== -1) {
            var pEnd = findMatchingDelim(cssText, pBrace, '{', '}');
            if (pEnd !== -1) {
              i = pEnd + 1;
              continue;
            }
          }
        }
        var nextAt = cssText.indexOf('@', i + 1);
        if (nextAt === -1) {
          out.push(cssText.slice(i));
          break;
        }
        out.push(cssText.slice(i, nextAt));
        i = nextAt;
      }

      var result = out.join('');
      // Strip :where(...) & group/peer :is(:where(...)) wrappers for WebView < 88 (Android 7.0-10)
      if (!supportsWhere) {
        result = result.replace(/(\.[^{},]+):is\(:where\(([^)]+)\):hover \*\)/g, '$2:hover $1');
        result = result.replace(/(\.[^{},]+):is\(:where\(([^)]+)\):checked ~ \*\)/g, '$2:checked ~ $1');
        result = stripBalancedPseudo(result, ':where(');
      }
      // Replace CSS inset: 0 with explicit top/right/bottom/left for WebView < 87
      if (!supportsInset) {
        result = result.replace(/\binset\s*:\s*0(?:px)?\s*([;}])/g, 'top:0;right:0;bottom:0;left:0$1');
        result = result.replace(/\binset-y\s*:\s*0(?:px)?\s*([;}])/g, 'top:0;bottom:0$1');
        result = result.replace(/\binset-x\s*:\s*0(?:px)?\s*([;}])/g, 'left:0;right:0$1');
      }
      return result;
    }

    window.__samiUnwrapLegacyCss = unwrapLegacyCss;

    if (!supportsAtLayer || !supportsWhere || !supportsInset) {
      var injectUnlayered = function(rawCss) {
        if (!rawCss || document.getElementById('sami-legacy-unlayered-css')) return;
        var converted = unwrapLegacyCss(rawCss);
        var styleEl = document.createElement('style');
        styleEl.id = 'sami-legacy-unlayered-css';
        styleEl.textContent = converted;
        var head = document.head || docEl;
        var compatLink = document.querySelector('link[href*="sami-visual-compat.css"]');
        if (compatLink && compatLink.parentNode === head) {
          head.insertBefore(styleEl, compatLink);
        } else {
          head.appendChild(styleEl);
        }
      };

      try {
        if (typeof window.fetch === 'function') {
          window.fetch('/assets/index-D5y8_Xmj.css')
            .then(function(r) { return r.ok ? r.text() : ''; })
            .then(injectUnlayered)
            ['catch'](function() {});
        } else {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', '/assets/index-D5y8_Xmj.css', true);
          xhr.onreadystatechange = function() {
            if (xhr.readyState === 4 && (xhr.status === 200 || xhr.status === 0)) {
              injectUnlayered(xhr.responseText);
            }
          };
          xhr.send();
        }
      } catch (e) {}
    }

    // 7. Runtime FPS Measurement Utility (uses native requestAnimationFrame)
    window.__samiMeasureFps = function(durationMs, callback) {
      var ms = Number(durationMs) || 600;
      var startTs = 0;
      var frames = 0;
      var rafFn = window.requestAnimationFrame || window.webkitRequestAnimationFrame;
      if (typeof rafFn !== 'function') {
        if (typeof callback === 'function') callback({ fps: 0, frames: 0, supported: false });
        return;
      }
      function step(ts) {
        if (!startTs) startTs = ts;
        frames++;
        var elapsed = ts - startTs;
        if (elapsed < ms) {
          rafFn(step);
        } else {
          var fps = elapsed > 0 ? Math.round((frames * 1000) / elapsed) : 0;
          if (typeof callback === 'function') {
            callback({ fps: fps, frames: frames, elapsedMs: Math.round(elapsed), supported: true });
          }
        }
      }
      rafFn(step);
    };
  } catch (err) {}
})();
