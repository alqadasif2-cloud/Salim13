import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './src/server/routes.ts';

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();

  // CORS for Android APK WebView (appassets.androidplatform.net), Cloud Run & AI Studio origins
  const configuredAppOrigin = (() => {
    const raw = (process.env.APP_URL || '').trim();
    if (!raw || raw === 'MY_APP_URL') return '';
    try {
      return new URL(raw).origin.toLowerCase();
    } catch {
      return '';
    }
  })();

  const isAllowedOrigin = (originHeader: string): boolean => {
    try {
      const parsed = new URL(originHeader);
      const originLower = parsed.origin.toLowerCase();
      if (configuredAppOrigin && originLower === configuredAppOrigin) return true;
      const host = parsed.hostname.toLowerCase();
      if (
        originLower === 'https://appassets.androidplatform.net' ||
        originLower === 'capacitor://localhost' ||
        originLower === 'ionic://localhost'
      ) {
        return true;
      }
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        (host === 'localhost' || host === '127.0.0.1')
      ) {
        return true;
      }
      if (
        parsed.protocol === 'https:' &&
        (host.endsWith('.run.app') ||
          host === 'aistudio.google.com' ||
          host.endsWith('.aistudio.google.com') ||
          host.endsWith('.googleusercontent.com') ||
          host.endsWith('.usercontent.goog') ||
          host.endsWith('.web.app') ||
          host.endsWith('.firebaseapp.com'))
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  app.use((req, res, next) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Accept, Origin, Content-Type, Authorization, X-Requested-With, x-sami-session, x-upload-id, x-offset, x-total-size, Cache-Control, Pragma'
    );
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use(
    express.raw({
      type: ['application/octet-stream', 'application/vnd.android.package-archive'],
      limit: '100mb',
    })
  );

  const uploadsDir = path.resolve('data/uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  app.use('/uploads', express.static(uploadsDir));
  app.use('/api', apiRouter);

  // Serve Service Worker & Web App Manifest with explicit standby/no-cache headers
  const resolvePublicOrDistFile = (relName: string): string | null => {
    const candidates = isProd
      ? [path.resolve('dist', relName), path.resolve('public', relName)]
      : [path.resolve('public', relName), path.resolve('dist', relName)];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  };

  app.get('/firebase-messaging-sw.js', (_req, res) => {
    const swPath = resolvePublicOrDistFile('firebase-messaging-sw.js');
    if (!swPath) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(swPath);
  });

  app.get('/manifest.json', (_req, res) => {
    const manifestPath = resolvePublicOrDistFile('manifest.json');
    if (!manifestPath) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(manifestPath);
  });

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve('dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Salim Server] Listening on http://0.0.0.0:${PORT} (${isProd ? 'production' : 'development'})`);
  });
}

startServer().catch((err) => {
  console.error('[Salim Server] Failed to start:', err);
  process.exit(1);
});
