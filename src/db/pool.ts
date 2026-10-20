import pg from 'pg';

// int8 -> number. Energy registers are Wh counters far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// NUMERIC (money, tariffs) deliberately stays a string: never a JS float.

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  pool.on('error', (err) => {
    // An idle client died (e.g. DB failover). The pool replaces it on next use.
    console.error('pg pool error', err.message);
  });
  return pool;
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export interface TenantContext {
  subject: string;
  role: 'operator' | 'platform_admin';
  // null only for platform_admin
  operatorId: string | null;
  expiresAt?: number; // token expiry (ms), for long-lived streams
}

// Every API query runs inside a transaction that pins the tenant for row-level
// security. The tenant comes from the verified token, never from the request URL.
export async function withTenant<T>(
  pool: pg.Pool,
  ctx: TenantContext,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withTx(pool, async (c) => {
    await c.query(`SELECT set_config('app.operator_id', $1, true), set_config('app.role', $2, true)`, [
      ctx.operatorId ?? '',
      ctx.role,
    ]);
    return fn(c);
  });
}
