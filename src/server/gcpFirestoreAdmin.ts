import { getApp, getApps, initializeApp, applicationDefault, type App } from 'firebase-admin/app';
import { projectId, databaseId } from './db.ts';

let cachedToken: { token: string; expiresAt: number } | null = null;
let adcCredential: ReturnType<typeof applicationDefault> | null = null;
let adcUnavailable = false;
let adminRestPermissionDenied = false;

export function getFirebaseAdminApp(): App | null {
  if (!projectId || projectId === 'remixed-project-id') {
    return null;
  }
  try {
    if (getApps().length > 0) {
      return getApp();
    }
    if (!adcCredential) {
      adcCredential = applicationDefault();
    }
    return initializeApp({
      credential: adcCredential,
      projectId,
    });
  } catch {
    return null;
  }
}

export async function getGcpAdminAccessToken(): Promise<string | null> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }
  if (adcUnavailable) {
    return null;
  }

  try {
    if (!adcCredential) {
      adcCredential = applicationDefault();
    }
    const tokenResult = await adcCredential.getAccessToken();
    if (tokenResult?.access_token) {
      cachedToken = {
        token: String(tokenResult.access_token),
        expiresAt: Date.now() + Number(tokenResult.expires_in || 3600) * 1000,
      };
      return cachedToken.token;
    }
  } catch {
    adcUnavailable = true;
  }

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
  if (adminRestPermissionDenied) return null;
  const token = await getGcpAdminAccessToken();
  if (!token) return null;

  const url = `${getDocsBaseUrl()}/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return null;
  if (res.status === 403) {
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
  if (adminRestPermissionDenied) return false;
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
  if (res.status === 403) {
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
  if (adminRestPermissionDenied) return [];
  const token = await getGcpAdminAccessToken();
  if (!token) return [];

  const url = `${getDocsBaseUrl()}/${encodeURIComponent(collection)}?pageSize=${Math.min(500, Math.max(1, pageSize))}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(6000),
  });
  if (res.status === 404) return [];
  if (res.status === 403) {
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
  if (adminRestPermissionDenied) return false;
  const token = await getGcpAdminAccessToken();
  if (!token) return false;

  const url = `${getDocsBaseUrl()}/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(4000),
  });
  if (res.status === 403) {
    adminRestPermissionDenied = true;
    return false;
  }
  if (res.status === 404 || res.ok) return true;
  return false;
}
