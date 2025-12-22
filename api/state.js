import { put, head } from '@vercel/blob';

// Prefer a namespaced pathname to avoid collisions.
// We keep backward-compat by reading the legacy key as a fallback.
const STATE_ID = 'state/app-state.json';
const LEGACY_STATE_ID = 'app-state.json';

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function redactString(value) {
  if (typeof value !== 'string') return value;
  // Redact URLs that might embed credentials.
  return value.replace(/(postgres(?:ql)?:\/\/)([^\s@]+)@/gi, '$1***@');
}

function safeSerializeError(err) {
  const seen = new WeakSet();
  const scrub = (input, depth = 0) => {
    if (depth > 3) return '[Max Depth]';
    if (input == null) return input;
    if (typeof input === 'string') return redactString(input);
    if (typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input !== 'object') return String(input);
    
    // Prevent circular references
    if (seen.has(input)) return '[Circular]';
    seen.add(input);

    const out = Array.isArray(input) ? [] : {};
    try {
      for (const [k, v] of Object.entries(input)) {
        const key = String(k).toLowerCase();
        if (key.includes('password') || key.includes('secret') || key.includes('token') || key.includes('connection') || key.includes('url')) {
          out[k] = '***';
          continue;
        }
        out[k] = scrub(v, depth + 1);
      }
    } catch {
      return '[Error serializing]';
    }
    return out;
  };

  try {
    if (err instanceof Error) {
      return {
        name: err.name,
        message: redactString(err.message),
        stack: err.stack ? redactString(err.stack.split('\n').slice(0, 3).join('\n')) : undefined,
      };
    }
    return scrub(err);
  } catch {
    return { error: 'Failed to serialize error details' };
  }
}

async function getBlobState() {
  const normalizePublicBlobUrl = (inputUrl) => {
    try {
      const u = new URL(inputUrl);
      // Some environments may return a non-public hostname (e.g. <id>.blob.vercel-storage.com)
      // even though the blob is publicly readable at <id>.public.blob.vercel-storage.com.
      if (u.hostname.endsWith('.blob.vercel-storage.com') && !u.hostname.includes('.public.')) {
        const firstDot = u.hostname.indexOf('.');
        const storeId = firstDot > 0 ? u.hostname.slice(0, firstDot) : '';
        if (storeId) {
          u.hostname = `${storeId}.public.blob.vercel-storage.com`;
        }
      }
      return u.toString();
    } catch {
      return inputUrl;
    }
  };

  const withCacheBust = (inputUrl, cacheBustValue) => {
    try {
      const u = new URL(inputUrl);
      u.searchParams.set('v', String(cacheBustValue));
      return u.toString();
    } catch {
      // Fallback for malformed URLs.
      const suffix = inputUrl.includes('?') ? '&' : '?';
      return `${inputUrl}${suffix}v=${encodeURIComponent(String(cacheBustValue))}`;
    }
  };

  const tryHeadThenFetch = async (pathname) => {
    const blobInfo = await head(pathname);
    const uploadedAtValue = (() => {
      try {
        const date = blobInfo.uploadedAt instanceof Date ? blobInfo.uploadedAt : new Date(blobInfo.uploadedAt);
        const t = date.getTime();
        return Number.isFinite(t) ? t : Date.now();
      } catch {
        return Date.now();
      }
    })();

    const rawCandidates = [blobInfo.url, blobInfo.downloadUrl].filter(Boolean).map(normalizePublicBlobUrl);
    const candidates = rawCandidates.map((u) => withCacheBust(u, uploadedAtValue));
    let lastStatus = null;
    let lastText = '';

    for (const fetchUrl of candidates) {
      const response = await fetch(fetchUrl, {
        cache: 'no-store',
        headers: {
          Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
        },
      });
      if (response.ok) {
        let data;
        try {
          data = await response.json();
        } catch {
          const text = await response.text();
          throw new Error(`Blob did not return JSON (first 120 chars): ${text.slice(0, 120)}`);
        }
        return {
          state: data.state ?? null,
          updatedAt: data.updatedAt ?? null,
        };
      }
      lastStatus = `${response.status} ${response.statusText}`;
      try {
        lastText = await response.text();
      } catch {
        lastText = '';
      }
      // Try next candidate for 403/404 and similar.
    }

    throw new Error(`Failed to fetch blob: ${lastStatus ?? 'unknown'}${lastText ? ` (${lastText.slice(0, 120)})` : ''}`);
  };

  try {
    // First try the namespaced key.
    return await tryHeadThenFetch(STATE_ID);
  } catch (err) {
    // If it's a simple "not found", fall back to legacy key.
    const message = err instanceof Error ? err.message : String(err);
    const notFound = /not\s*found|404/i.test(message);
    if (!notFound) throw err;
  }

  try {
    return await tryHeadThenFetch(LEGACY_STATE_ID);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notFound = /not\s*found|404/i.test(message);
    if (notFound) return { state: null, updatedAt: null };
    throw err;
  }
}

async function setBlobState(state) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN is not set. Connect Vercel Blob and ensure the env var exists in this deployment environment.');
  }
  const updatedAt = new Date().toISOString();
  const payload = JSON.stringify({ state, updatedAt });
  
  const blob = await put(STATE_ID, payload, {
    access: 'public',
    contentType: 'application/json',
    // Ensure we overwrite the same key; otherwise sync will never converge.
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  
  return { ok: true, updatedAt, url: blob.url };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const data = await getBlobState();
      return json(res, 200, data);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
      if (!body || typeof body !== 'object' || !('state' in body)) {
        return json(res, 400, { error: 'Missing `state` in request body.' });
      }

      const result = await setBlobState(body.state);
      return json(res, 200, result);
    }

    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    const details = safeSerializeError(err);
    const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unexpected error';
    return json(res, 500, { error: 'Internal Server Error', message: redactString(message), details });
  }
}
