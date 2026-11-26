import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { isFirestoreRestBackoffActive } from './db.ts';
import { adminFirestoreGetDoc, adminFirestoreSetDoc } from './gcpFirestoreAdmin.ts';

export interface AuthUser {
  id: number;
  username: string;
  displayName?: string;
  role: string;
  avatarUrl?: string | null;
  isGuest?: boolean;
  isRestrictedAdmin?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      authVerifiedByJwt?: boolean;
    }
  }
}

const DATA_DIR = path.resolve('data');
const JWT_SECRET_FILE = path.join(DATA_DIR, 'jwt_secret.key');
const SECRETS_COLLECTION = '_server_secrets';
const JWT_SECRET_DOC_ID = 'jwt_config';

let activeJwtSecret: string | null = null;
let jwtSecretHydrated = false;
let jwtSecretInitPromise: Promise<string> | null = null;

function readDiskJwtSecret(): string {
  try {
    if (fs.existsSync(JWT_SECRET_FILE)) {
      const val = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
      if (val.length >= 32) return val;
    }
  } catch {}
  return '';
}

function writeDiskJwtSecret(secret: string): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(JWT_SECRET_FILE, secret, { encoding: 'utf8', mode: 0o600 });
  } catch {}
}

function getSyncJwtSecret(): string {
  const envSecret = process.env.JWT_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) {
    activeJwtSecret = envSecret;
    jwtSecretHydrated = true;
    return envSecret;
  }
  if (activeJwtSecret) return activeJwtSecret;

  const diskSecret = readDiskJwtSecret();
  if (diskSecret) {
    activeJwtSecret = diskSecret;
    return diskSecret;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  activeJwtSecret = generated;
  writeDiskJwtSecret(generated);
  return generated;
}

export async function ensureJwtSecretReady(): Promise<string> {
  const envSecret = process.env.JWT_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) {
    activeJwtSecret = envSecret;
    jwtSecretHydrated = true;
    return envSecret;
  }
  if (jwtSecretHydrated && activeJwtSecret) {
    return activeJwtSecret;
  }
  if (jwtSecretInitPromise) {
    return jwtSecretInitPromise;
  }

  jwtSecretInitPromise = (async () => {
    const localCandidate = readDiskJwtSecret() || activeJwtSecret;
    if (!isFirestoreRestBackoffActive()) {
      try {
        const remoteDoc = await adminFirestoreGetDoc(SECRETS_COLLECTION, JWT_SECRET_DOC_ID);
        const remoteSecret = remoteDoc ? String(remoteDoc.secret || '').trim() : '';
        if (remoteSecret && remoteSecret.length >= 32) {
          activeJwtSecret = remoteSecret;
          writeDiskJwtSecret(remoteSecret);
          jwtSecretHydrated = true;
          return remoteSecret;
        }
        const secretToPersist = localCandidate && localCandidate.length >= 32
          ? localCandidate
          : crypto.randomBytes(32).toString('hex');
        const persisted = await adminFirestoreSetDoc(SECRETS_COLLECTION, JWT_SECRET_DOC_ID, {
          id: JWT_SECRET_DOC_ID,
          secret: secretToPersist,
          algorithm: 'HS256',
          updatedAt: Date.now(),
        });
        if (persisted || localCandidate) {
          activeJwtSecret = secretToPersist;
          writeDiskJwtSecret(secretToPersist);
          jwtSecretHydrated = true;
          return secretToPersist;
        }
      } catch (err: any) {
        console.warn('[Salim Auth] Notice syncing persistent JWT key:', err?.message || err);
      }
    }

    const fallback = localCandidate && localCandidate.length >= 32
      ? localCandidate
      : getSyncJwtSecret();
    activeJwtSecret = fallback;
    writeDiskJwtSecret(fallback);
    jwtSecretHydrated = true;
    return fallback;
  })();

  try {
    return await jwtSecretInitPromise;
  } finally {
    jwtSecretInitPromise = null;
  }
}

void ensureJwtSecretReady();

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) {
    str += '=';
  }
  return Buffer.from(str, 'base64').toString('utf8');
}

export function generateToken(payload: AuthUser, expiresInDays = 30): string {
  const secret = getSyncJwtSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + expiresInDays * 24 * 60 * 60;
  const fullPayload = { ...payload, exp, iat: Math.floor(Date.now() / 1000) };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifyToken(token: string): AuthUser | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;

  const secret = getSyncJwtSecret();
  const [headerB64, payloadB64, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  if (signature !== expectedSig) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null;
    }
    return {
      id: Number(payload.id),
      username: String(payload.username || ''),
      displayName: payload.displayName ? String(payload.displayName) : undefined,
      role: String(payload.role || 'user'),
      avatarUrl: payload.avatarUrl || null,
      isGuest: Boolean(payload.isGuest),
      isRestrictedAdmin: Boolean(payload.isRestrictedAdmin || Number(payload.id) === 76 || Number(payload.id) === 77),
    };
  } catch {
    return null;
  }
}

const sessionCache = new Map<number, { user: AuthUser; time: number }>();

export function clearAuthSessionCache(userId: number) {
  sessionCache.delete(userId);
}

export async function authenticateToken(req: Request, _res: Response, next: NextFunction) {
  await ensureJwtSecretReady();
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    const user = verifyToken(token);
    if (user) {
      req.user = user;
    }
  } else if (req.query?.token) {
    const user = verifyToken(String(req.query.token).trim());
    if (user) {
      req.user = user;
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول للوصول إلى هذا المورد' });
  }
  next();
}

export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'غير مصرح لك بالوصول إلى هذا الإجراء' });
    }
    next();
  };
}
