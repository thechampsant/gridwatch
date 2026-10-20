import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

// Minimal forward-only migration runner: plain SQL files applied in name order,
// each in its own transaction, recorded in schema_migrations.
export async function runMigrations(adminUrl: string, dir: string, log = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    // Serialise concurrent runners (e.g. two replicas starting together).
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['gridwatch-migrations']);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied migration ${file}`);
    }
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['gridwatch-migrations']);
  } finally {
    await client.end();
  }
  return applied;
}

// Role passwords are not in the migrations; they come from the environment.
export async function setRolePasswords(adminUrl: string, passwords: Record<string, string>): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const [role, password] of Object.entries(passwords)) {
      await client.query(`ALTER ROLE ${client.escapeIdentifier(role)} PASSWORD ${client.escapeLiteral(password)}`);
    }
  } finally {
    await client.end();
  }
}

// The stub data is dated June 2026. Left running, the retention and
// compression jobs would drop or compress it straight away, so demo and test
// databases pause them. Production keeps them scheduled.
export async function pauseTelemetryPolicies(adminUrl: string): Promise<number> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT alter_job(job_id, scheduled => false)
         FROM timescaledb_information.jobs
        WHERE hypertable_name IN ('meter_readings', 'status_events', 'fault_events')`,
    );
    return r.rowCount ?? 0;
  } finally {
    await client.end();
  }
}
