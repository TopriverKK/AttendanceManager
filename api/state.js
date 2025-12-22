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
  const tryHeadThenFetch = async (pathname) => {
    const blobInfo = await head(pathname);
    const response = await fetch(blobInfo.url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to fetch blob: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return {
      state: data.state ?? null,
      updatedAt: data.updatedAt ?? null,
    };
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
