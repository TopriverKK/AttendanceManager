import { sql } from '@vercel/postgres';

const STATE_ID = 'default';

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS app_state (
      id text PRIMARY KEY,
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `;
}

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  try {
    await ensureSchema();

    if (req.method === 'GET') {
      const result = await sql`SELECT state, updated_at FROM app_state WHERE id = ${STATE_ID};`;
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
      const upsert = await sql`
        INSERT INTO app_state (id, state)
        VALUES (${STATE_ID}, ${serialized}::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET state = EXCLUDED.state, updated_at = now()
        RETURNING updated_at;
      `;

      return json(res, 200, { ok: true, updatedAt: upsert.rows?.[0]?.updated_at ?? null });
    }

    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    // If Postgres isn't configured yet, this is the most common failure.
    const message = err instanceof Error ? err.message : String(err);
    return json(res, 500, { error: 'Internal Server Error', message });
  }
}
