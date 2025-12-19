import { createClient, createPool } from '@vercel/postgres';

const STATE_ID = 'default';

function isInvalidConnectionStringError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('invalid_connection_string');
}

function pickFirst(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

async function withDb(fn) {
  // Prefer pooled connections (best for serverless). If the env provides a direct
  // connection string, @vercel/postgres will throw `invalid_connection_string`.
  try {
    const pooled = pickFirst(process.env.POSTGRES_URL, process.env.DATABASE_URL, process.env.PRISMA_DATABASE_URL);
    const pool = pooled ? createPool({ connectionString: pooled }) : createPool();
    return await fn(pool);
  } catch (err) {
    if (!isInvalidConnectionStringError(err)) throw err;

    const direct = pickFirst(
      process.env.POSTGRES_URL_NON_POOLING,
      process.env.POSTGRES_URL,
      process.env.DATABASE_URL,
      process.env.PRISMA_DATABASE_URL,
    );
    if (!direct) {
      throw new Error(
        "Missing Postgres connection string. Set one of POSTGRES_URL / POSTGRES_URL_NON_POOLING / DATABASE_URL / PRISMA_DATABASE_URL for this deployment.",
      );
    }

    const client = createClient({ connectionString: direct });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
}

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id text PRIMARY KEY,
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

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
  const scrub = (input) => {
    if (input == null) return input;
    if (typeof input === 'string') return redactString(input);
    if (typeof input !== 'object') return input;
    if (seen.has(input)) return '[Circular]';
    seen.add(input);

    const out = Array.isArray(input) ? [] : {};
    for (const [k, v] of Object.entries(input)) {
      const key = String(k).toLowerCase();
      if (key.includes('password') || key.includes('secret') || key.includes('token') || key.includes('connection') || key.includes('url')) {
        out[k] = '***';
        continue;
      }
      out[k] = scrub(v);
    }
    return out;
  };

  if (err instanceof Error) {
    return scrub({
      name: err.name,
      message: redactString(err.message),
      // Some libraries attach extra details.
      cause: err.cause,
    });
  }

  return scrub(err);
}

export default async function handler(req, res) {
  try {
    await withDb(async (db) => {
      await ensureSchema(db);

      if (req.method === 'GET') {
        const result = await db.query('SELECT state, updated_at FROM app_state WHERE id = $1;', [STATE_ID]);
        const row = result.rows?.[0];
        if (!row) {
          return json(res, 200, { state: null, updatedAt: null });
        }

        const state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
        return json(res, 200, { state, updatedAt: row.updated_at });
      }

      if (req.method === 'POST') {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
        if (!body || typeof body !== 'object' || !('state' in body)) {
          return json(res, 400, { error: 'Missing `state` in request body.' });
        }

        const serialized = JSON.stringify(body.state);
        const upsert = await db.query(
          `
          INSERT INTO app_state (id, state)
          VALUES ($1, $2::jsonb)
          ON CONFLICT (id)
          DO UPDATE SET state = EXCLUDED.state, updated_at = now()
          RETURNING updated_at;
          `,
          [STATE_ID, serialized],
        );

        return json(res, 200, { ok: true, updatedAt: upsert.rows?.[0]?.updated_at ?? null });
      }

      res.setHeader('Allow', 'GET, POST');
      return json(res, 405, { error: 'Method not allowed' });
    });
  } catch (err) {
    // If Postgres isn't configured yet, this is the most common failure.
    const details = safeSerializeError(err);
    const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unexpected error';
    return json(res, 500, { error: 'Internal Server Error', message: redactString(message), details });
  }
}
