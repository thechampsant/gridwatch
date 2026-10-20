import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { StaticSecretProvider } from '../../src/archive/aws.js';
import { issueToken } from '../../src/api/auth.js';
import { buildServer } from '../../src/api/server.js';
import { fixedClock } from '../../src/clock.js';
import { signBody } from '../../src/csms/signature.js';
import { withTenant } from '../../src/db/pool.js';
import { STUBS, stub } from '../helpers/fixtures.js';
import { drain, enqueue, pools, resetDb } from './db.js';

// The API as an operator's client sees it: tenant isolation enforced by the
// database, webhook authentication, and nearest-available correctness.

const SECRET = 'test-webhook-secret';
const JWT = 'test-jwt-secret';
const AS_OF = '2026-06-09T13:15:00Z'; // 18:45 IST / 15:15 CEST
const { admin, ingest, api } = pools();
let app: FastifyInstance;
let acme: string;
let stadtwerke: string;
let platform: string;

beforeAll(async () => {
  app = await buildServer({
    ingestPool: ingest,
    apiPool: api,
    secrets: new StaticSecretProvider([SECRET]),
    clock: fixedClock(AS_OF),
    jwtSecret: JWT,
    demoMode: false,
    staleAfterSec: 300,
  });
  acme = await issueToken(JWT, { sub: 't-acme', role: 'operator', operator_id: 'acme-charge' });
  stadtwerke = await issueToken(JWT, { sub: 't-stw', role: 'operator', operator_id: 'stadtwerke-ev' });
  platform = await issueToken(JWT, { sub: 't-admin', role: 'platform_admin' });
});
afterAll(async () => {
  await app.close();
  await Promise.all([admin.end(), ingest.end(), api.end()]);
});
beforeEach(async () => {
  await resetDb(admin);
  for (const s of [STUBS.page1, STUBS.page2, STUBS.malformed]) await enqueue(ingest, 'poll', stub(s));
  for (const s of [STUBS.webhookNormal, STUBS.webhookOutOfOrder, STUBS.webhookMeterReset]) await enqueue(ingest, 'webhook', stub(s));
  const { _note, ...faultPage } = stub(STUBS.pilotFaultPage);
  await enqueue(ingest, 'poll', faultPage);
  await drain(ingest);
  // Every site confirmed by the vendor one minute before AS_OF.
  await admin.query(`UPDATE poll_state SET last_contact_at = $1::timestamptz - interval '60 seconds'`, [AS_OF]);
});

const get = (url: string, token?: string) =>
  app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('tenant isolation', () => {
  it('ignores ?operator_id=: the tenant comes only from the token', async () => {
    const r = await get('/v1/sites/status?operator_id=stadtwerke-ev', acme);
    expect(r.statusCode).toBe(200);
    expect(r.json().sites.map((s: { siteId: string }) => s.siteId).sort()).toEqual(['S-IN-0007', 'S-IN-0012']);

    const sessions = (await get('/v1/sessions?operator_id=acme-charge', stadtwerke)).json().sessions;
    expect(sessions.map((s: { session_id: string }) => s.session_id)).toEqual(['sess-de-99x']);
  });

  it('platform admins see every tenant; operators cannot reach admin endpoints', async () => {
    expect((await get('/v1/sites/status', platform)).json().sites).toHaveLength(3);
    expect((await get('/v1/admin/csms-calls', acme)).statusCode).toBe(403);
    expect((await get('/v1/admin/quarantine', platform)).statusCode).toBe(200);
  });

  it('rejects missing and forged tokens', async () => {
    expect((await get('/v1/sites/status')).statusCode).toBe(401);
    const forged = await issueToken('not-the-secret', { sub: 'x', role: 'platform_admin' });
    expect((await get('/v1/sites/status', forged)).statusCode).toBe(401);
  });

  it('fails closed in the database: no tenant set means no rows, even for a buggy query', async () => {
    const n = await withTenant(api, { subject: 'bug', role: 'operator', operatorId: null }, async (c) =>
      (await c.query(`SELECT count(*)::int AS n FROM sites`)).rows[0].n,
    );
    expect(n).toBe(0);
  });
});

describe('webhook authentication', () => {
  const body = JSON.stringify(stub(STUBS.webhookDuplicate));
  const post = (signature?: string) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/csms/csms-main',
      headers: { 'content-type': 'application/json', ...(signature ? { 'x-csms-signature': signature } : {}) },
      payload: body,
    });
  const inboxCount = async () => (await admin.query(`SELECT count(*)::int AS n FROM csms_inbox`)).rows[0].n;

  it('rejects a bad or missing signature and stores nothing', async () => {
    const before = await inboxCount();
    expect((await post(signBody(body, 'wrong-secret'))).statusCode).toBe(401);
    expect((await post()).statusCode).toBe(401);
    expect(await inboxCount()).toBe(before);
  });

  it('accepts a valid signature and acknowledges only after the durable write', async () => {
    const before = await inboxCount();
    const r = await post(signBody(body, SECRET));
    expect(r.statusCode).toBe(202);
    expect(await inboxCount()).toBe(before + 1);
  });
});

describe('nearest available charger', () => {
  // Haversine on a sphere; PostGIS uses the spheroid, so allow 0.5%.
  const km = (a: [number, number], b: [number, number]) => {
    const rad = (d: number) => (d * Math.PI) / 180;
    const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
  };

  it('finds Sector 18 Metro from Noida Sector 62 with geodesic distance and its Available connectors', async () => {
    const r = (await get('/v1/chargers/nearest?lat=28.628&lng=77.3649', acme)).json();
    expect(r.results).toHaveLength(1);
    const hit = r.results[0];
    expect(hit.siteId).toBe('S-IN-0007');
    expect(hit.distanceKm).toBeCloseTo(km([28.628, 77.3649], [28.5708, 77.3261]), 0);
    expect(Math.abs(hit.distanceKm - km([28.628, 77.3649], [28.5708, 77.3261])) / hit.distanceKm).toBeLessThan(0.005);
    expect(hit.available.map((a: { chargerId: string; connectorId: string }) => `${a.chargerId}/${a.connectorId}`).sort()).toEqual([
      'C-IN-0007-A/1',
      'C-IN-0007-B/1',
    ]);
  });

  it('skips a closer faulted site and says why', async () => {
    const r = (await get('/v1/chargers/nearest?lat=12.9756&lng=77.6068&max_km=50', acme)).json();
    expect(r.results).toEqual([]);
    expect(r.skippedCloser).toMatchObject([{ siteId: 'S-IN-0012', reason: 'Faulted, nothing Available' }]);
    expect(r.nearestBeyondRadius.siteId).toBe('S-IN-0007'); // ~1,700 km away in Noida
  });

  it('never recommends a site whose data is stale', async () => {
    await admin.query(`UPDATE poll_state SET last_contact_at = $1::timestamptz - interval '2 hours'`, [AS_OF]);
    const r = (await get('/v1/chargers/nearest?lat=28.628&lng=77.3649', acme)).json();
    expect(r.results).toEqual([]);
    expect(r.skippedCloser[0]).toMatchObject({ siteId: 'S-IN-0007' });
    expect(r.skippedCloser[0].reason).toMatch(/^Stale/);
  });

  it('keeps sites without coordinates off the map and out of nearest results', async () => {
    await admin.query(`UPDATE sites SET location = NULL, geocode_status = 'unresolved' WHERE site_id = 'S-IN-0007'`);
    const r = (await get('/v1/chargers/nearest?lat=28.628&lng=77.3649', acme)).json();
    expect(r.results).toEqual([]);
    const map = (await get('/v1/map/sites', acme)).json();
    expect(map.features.map((f: { id: string }) => f.id)).toEqual(['S-IN-0012']);
    expect(map.unresolved.map((u: { siteId: string }) => u.siteId)).toEqual(['S-IN-0007']);
  });

  it('never searches other tenants', async () => {
    const r = (await get('/v1/chargers/nearest?lat=48.7784&lng=9.18&max_km=2000', acme)).json();
    expect(r.results.every((x: { siteId: string }) => x.siteId.startsWith('S-IN'))).toBe(true);
  });
});
