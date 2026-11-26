import crypto from 'crypto';
import { projectId, databaseId } from './db.ts';

let cachedToken: { token: string; expiresAt: number } | null = null;
let serviceAccountUnavailable = false;
let adminRestPermissionDenied = false;

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export async function getGcpAdminAccessToken(): Promise<string | null> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  // 1. Optional GCP_SERVICE_ACCOUNT_KEY JSON or base64 JSON
  const rawKey = process.env.GCP_SERVICE_ACCOUNT_KEY?.trim();
  if (rawKey && !serviceAccountUnavailable) {
    try {
      const jsonStr = rawKey.startsWith('{') ? rawKey : Buffer.from(rawKey, 'base64').toString('utf8');
      const sa = JSON.parse(jsonStr);
      if (sa?.client_email && sa?.private_key) {
        const now = Math.floor(Date.now() / 1000);
        const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const claims = base64Url(
          JSON.stringify({
            iss: sa.client_email,
            scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
            aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600,
          })
        );
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(`${header}.${claims}`);
        const sig = base64Url(signer.sign(sa.private_key));
        const assertion = `${header}.${claims}.${sig}`;

        const resp = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
          }),
          signal: AbortSignal.timeout(4000),
        });
        if (resp.ok) {
          const data: any = await resp.json();
          if (data?.access_token) {
            cachedToken = {
              token: String(data.access_token),
              expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
            };
            adminRestPermissionDenied = false;
            return cachedToken.token;
          }
        }
      }
    } catch {
      serviceAccountUnavailable = true;
    }
  }

  // 2. Cloud Run / GCE Metadata Server (Application Default Credentials)
  try {
    const res = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(1500),
      }
    );
    if (res.ok) {
      const data: any = await res.json();
      if (data?.access_token) {
        cachedToken = {
          token: String(data.access_token),
          expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
        };
        return cachedToken.token;
      }
    }
  } catch {}

  return null;
}

function getDocsBaseUrl(): string {
  const db = encodeURIComponent(databaseId || '(default)');
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${db}/documents`;
}

function toFirestoreValue(val: unknown): Record<string, unknown> {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return { nullValue: null };
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.filter((v) => v !== undefined).map((v) => toFirestoreValue(v)),
      },
    };
  }
  if (typeof val === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = toFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreValue(val: any): unknown {
  if (!val || typeof val !== 'object') return undefined;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('stringValue' in val) return String(val.stringValue);
  if ('timestampValue' in val) return String(val.timestampValue);
  if ('arrayValue' in val) {
    const arr = val.arrayValue?.values;
    return Array.isArray(arr) ? arr.map((v: any) => fromFirestoreValue(v)) : [];
  }
  if ('mapValue' in val) {
    return fromFirestoreFields(val.mapValue?.fields);
  }
  return undefined;
}

function fromFirestoreFields(fields: Record<string, any> | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const [k, v] of Object.entries(fields)) {
    out[k] = fromFirestoreValue(v);
  }
  return out;
}

export async function adminFirestoreGetDoc(
  collection: string,
  docId: string
): Promise<Record<string, any> | null> {
  if (adminRestPermissionDenied && !process.env.GCP_SERVICE_ACCOUNT_KEY?.trim()) return null;
  const token = await getGcpAdminAccessToken();
  if (!token) return null;

  const url = `${getDocsBaseUrl()}/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return null;
  if (res.status === 403 && !process.env.GCP_SERVICE_ACCOUNT_KEY?.trim()) {
    adminRestPermissionDenied = true;
    return null;
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Firestore Admin GET ${collection}/${docId} failed (${res.status}): ${msg.slice(0, 140)}`);
  }
  const json: any = await res.json();
  return json?.fields ? fromFirestoreFields(json.fields) : null;
}

export async function adminFirestoreSetDoc(
  collection: string,
  docId: string,
  data: Record<string, any>
): Promise<boolean> {
  if (adminRestPermissionDenied && !process.env.GCP_SERVICE_ACCOUNT_KEY?.trim()) return false;
  const token = await getGcpAdminAccessToken();
  if (!token) return false;

  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields[k] = toFirestoreValue(v);
    }
  }

  const url = `${getDocsBaseUrl()}/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 403 && !process.env.GCP_SERVICE_ACCOUNT_KEY?.trim()) {
    adminRestPermissionDenied = true;
    return false;
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Firestore Admin SET ${collection}/${docId} failed (${res.status}): ${msg.slice(0, 140)}`);
  }
  return true;
}

export async function adminFirestoreListCollection(
  collection: string,
  pageSize = 200
): Promise<Array<{ id: string; data: Record<string, any> }>> {
  if (adminRestPermissionDenied && !process.env.GCP_SERVICE_ACCOUNT_KEY?.trim()) return [];
  const token = await getGcpAdminAccessToken();
  if (!token) return [];

  const url = `${getDocsBaseUrl()}/${encodeURIComponent(collection)}?pageSize=${Math.min(500, Math.max(1, pageSize))}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(6000),
  });
  if (res.status === 404) return [];
  if (res.status === 403 && !process.env.GCP_SERVICE_ACCOUNT_KEY?.trim()) {
    adminRestPermissionDenied = true;
    return [];
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Firestore Admin LIST ${collection} failed (${res.status}): ${msg.slice(0, 140)}`);
  }
  const json: any = await res.json();
  const docs = Array.isArray(json?.documents) ? json.documents : [];
  return docs.map((d: any) => {
    const nameParts = String(d?.name || '').split('/');
    const id = nameParts[nameParts.length - 1] || '';
    return { id, data: fromFirestoreFields(d?.fields) };
  });
}

export async function adminFirestoreDeleteDoc(collection: string, docId: string): Promise<boolean> {
  if (adminRestPermissionDenied && !process.env.GCP_SERVICE_ACCOUNT_KEY?.trim()) return false;
  const token = await getGcpAdminAccessToken();
  if (!token) return false;

  const url = `${getDocsBaseUrl()}/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(4000),
  });
  if (res.status === 403 && !process.env.GCP_SERVICE_ACCOUNT_KEY?.trim()) {
    adminRestPermissionDenied = true;
    return false;
  }
  if (res.status === 404 || res.ok) return true;
  return false;
}
