import path from 'node:path';
import pg from 'pg';
import { createPool, withTx, type Pool } from '../../src/db/pool.js';
import { processPending, type ProcessorOptions } from '../../src/ingest/processor.js';
import { CacheStep, geocodePendingSites, OverrideStep, PostalGazetteerStep } from '../../src/geo/geocoder.js';
import { loadCatalog, loadGazetteer } from '../../src/seed/catalog.js';
import { repoRoot } from '../helpers/fixtures.js';

// Integration tests run against a throwaway database (gridwatch_test) on the
// same Postgres as docker compose: port 55432 from the host, db:5432 inside
// compose (TEST_DATABASE_ADMIN_URL).
const adminBase = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:gridwatch@localhost:55432/postgres';
export const TEST_DB = 'gridwatch_test';

function dbUrl(db: string, user?: string, password?: string): string {
  const u = new URL(adminBase);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user;
    u.password = password ?? '';
  }
  return u.toString();
}

export const urls = {
  server: adminBase,
  admin: dbUrl(TEST_DB),
  ingest: dbUrl(TEST_DB, 'gridwatch_ingest', 'gridwatch_ingest'),
  api: dbUrl(TEST_DB, 'gridwatch_api', 'gridwatch_api'),
};

export const processorOptions: ProcessorOptions = {
  batchSize: 50,
  maxAttempts: 5,
  futureSkewSec: 300,
  energy: { tolerance: 1.1, resetMaxGapSec: 120 },
};

const DATA_TABLES = [
  'audit_log', 'settlement_statements', 'charges', 'sessions', 'fault_events', 'status_events', 'meter_readings',
  'connector_state', 'ingest_outcomes', 'csms_calls', 'poll_state', 'quarantine', 'csms_inbox', 'tariffs',
  'connectors', 'chargers', 'geocode_cache', 'geocode_overrides', 'sites', 'csms_connections', 'operators',
];

// Empty every table and load the 3-site pilot catalogue (no synthetic sites,
// so assertions are about exactly the data the stubs describe). Coverage tests
// ask for the generated sites too, since density needs more than three points.
export async function resetDb(admin: Pool, opts: { includeSynthetic?: boolean } = {}): Promise<void> {
  await admin.query(`TRUNCATE ${DATA_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  const seedDir = path.join(repoRoot, 'seed');
  const gazetteer = await loadGazetteer(seedDir);
  await withTx(admin, async (c) => {
    await loadCatalog(c, { seedDir, connectionId: 'csms-main', csmsBaseUrl: 'http://vendor', includeSynthetic: opts.includeSynthetic ?? false });
    await geocodePendingSites(c, [new OverrideStep(c), new CacheStep(c), new PostalGazetteerStep(gazetteer)]);
  });
}

export function pools() {
  return { admin: createPool(urls.admin, 4), ingest: createPool(urls.ingest, 6), api: createPool(urls.api, 4) };
}

// Put a vendor payload in the inbox exactly as the webhook receiver / poller would.
export async function enqueue(
  pool: Pool,
  source: 'webhook' | 'poll',
  payload: { site_id?: string; server_time?: string; delivery_id?: string; events: unknown[] },
  ref?: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO csms_inbox (connection_id, source, delivery_ref, site_id, server_time, payload)
     VALUES ('csms-main', $1, $2, $3, $4, $5)`,
    [source, ref ?? payload.delivery_id ?? `${payload.site_id}#test:p1`, payload.site_id ?? null, payload.server_time ?? null, JSON.stringify(payload)],
  );
}

export async function drain(pool: Pool, opts = processorOptions): Promise<void> {
  while ((await processPending(pool, opts)) > 0) {
    /* keep going */
  }
}

export async function serverClient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urls.server });
  await c.connect();
  return c;
}
