import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { StaticSecretProvider } from '../../src/archive/aws.js';
import { issueToken } from '../../src/api/auth.js';
import { buildServer } from '../../src/api/server.js';
import { fixedClock } from '../../src/clock.js';
import { STUBS, stub } from '../helpers/fixtures.js';
import { drain, enqueue, pools, resetDb } from './db.js';

// With the live simulator running for hours, the generated sites produce far
// more traffic than the pilot. The log and the vendor-call view must keep
// showing the newest rows, count everything, and keep the pilot evidence.

const JWT = 'test-jwt-secret';
const { admin, ingest, api } = pools();
let app: FastifyInstance;
let platform: string;

beforeAll(async () => {
  app = await buildServer({
    ingestPool: ingest,
    apiPool: api,
    secrets: new StaticSecretProvider(['unused']),
    clock: fixedClock('2026-06-09T13:15:00Z'),
    jwtSecret: JWT,
    demoMode: false,
    staleAfterSec: 300,
  });
  platform = await issueToken(JWT, { sub: 't-admin', role: 'platform_admin' });
});
afterAll(async () => {
  await app.close();
  await Promise.all([admin.end(), ingest.end(), api.end()]);
});

const CONNECTORS = [
  ['C-IN-0005-A', '1'],
  ['C-IN-0005-B', '1'],
  ['C-IN-0005-B', '2'],
  ['C-IN-0005-C', '1'],
];
beforeEach(async () => {
  await resetDb(admin, { includeSynthetic: true });
  for (const s of [STUBS.page1, STUBS.page2, STUBS.malformed]) await enqueue(ingest, 'poll', stub(s));
  await drain(ingest);
  // 300 status changes on a generated site, a minute apart.
  const t0 = Date.parse('2026-06-09T06:00:00Z');
  const events = Array.from({ length: 300 }, (_, i) => {
    const [charger_id, connector_id] = CONNECTORS[i % CONNECTORS.length]!;
    return { type: 'status', charger_id, connector_id, status: i % 2 ? 'Charging' : 'Available', ts: new Date(t0 + i * 60_000).toISOString() };
  });
  await enqueue(ingest, 'poll', { site_id: 'S-IN-0005', server_time: '2026-06-09T13:00:00Z', events });
  await drain(ingest);
  await admin.query(
    `INSERT INTO csms_calls (direction, connection_id, site_id, request, status_code, outcome, handling)
     VALUES ('poll', 'csms-main', 'S-IN-0007', 'GET /v1/chargers?site_id=S-IN-0007', 429, 'rate_limited', 'scripted'),
            ('poll', 'csms-main', 'S-DE-0003', 'GET /v1/chargers?site_id=S-DE-0003', 500, 'server_error', 'scripted')`,
  );
  await admin.query(
    `INSERT INTO csms_calls (direction, connection_id, site_id, request, status_code, outcome, handling)
     SELECT 'poll', 'csms-main', 'S-IN-0005', 'GET /v1/chargers?site_id=S-IN-0005', CASE WHEN g % 50 = 0 THEN 500 ELSE 200 END,
            CASE WHEN g % 50 = 0 THEN 'server_error' ELSE 'ok' END, 'live'
       FROM generate_series(1, 300) g`,
  );
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${platform}` } });

describe('a long-running network', () => {
  it('shows the newest events and counts all of them', async () => {
    const r = (await get('/v1/ingestion/events?include_synthetic=true&limit=50')).json();
    expect(r.shown).toBe(50);
    expect(r.total).toBeGreaterThan(300);
    expect(Object.values(r.counts as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(r.total);
    const newest = (await admin.query(`SELECT max(outcome_id)::int AS id FROM ingest_outcomes`)).rows[0].id;
    expect(r.events.at(-1).outcome_id).toBe(newest);
  });

  it('keeps the pilot log intact by default', async () => {
    const r = (await get('/v1/ingestion/events')).json();
    expect(r.events.every((e: { site_id: string }) => e.site_id !== 'S-IN-0005')).toBe(true);
    expect(r.counts.quarantined).toBe(2); // the two broken events in stub 1e
  });

  it("keeps the scripted 429 and 500 in view however much live traffic follows", async () => {
    const r = (await get('/v1/admin/csms-calls')).json();
    expect(r.counts).toMatchObject({ total: 302, rateLimited: 1, pollFailed: 7 });
    expect(r.notable.map((c: { status_code: number }) => c.status_code)).toEqual([429, 500]);
    expect(r.calls).toHaveLength(200);
    expect(r.recentErrors.map((c: { status_code: number }) => c.status_code).sort()).toEqual([429, 500, 500, 500, 500, 500, 500, 500]);
  });
});
