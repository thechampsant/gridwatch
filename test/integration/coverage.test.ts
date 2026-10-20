import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { StaticSecretProvider } from '../../src/archive/aws.js';
import { issueToken } from '../../src/api/auth.js';
import { buildServer } from '../../src/api/server.js';
import { fixedClock } from '../../src/clock.js';
import { STUBS, stub } from '../helpers/fixtures.js';
import { drain, enqueue, pools, resetDb } from './db.js';

// Coverage and density on the full 50-site pilot: counts that add up, tenant
// isolation, refusing false precision, and gaps that follow live status.

const JWT = 'test-jwt-secret';
const AS_OF = '2026-06-09T13:15:00Z';
const { admin, ingest, api } = pools();
let app: FastifyInstance;
let acme: string;
let stadtwerke: string;
let platform: string;

beforeAll(async () => {
  app = await buildServer({
    ingestPool: ingest,
    apiPool: api,
    secrets: new StaticSecretProvider(['unused']),
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
  await resetDb(admin, { includeSynthetic: true });
  for (const s of [STUBS.page1, STUBS.page2, STUBS.malformed]) await enqueue(ingest, 'poll', stub(s));
  for (const s of [STUBS.webhookNormal, STUBS.webhookOutOfOrder, STUBS.webhookMeterReset]) await enqueue(ingest, 'webhook', stub(s));
  const { _note, ...faultPage } = stub(STUBS.pilotFaultPage);
  await enqueue(ingest, 'poll', faultPage);
  await drain(ingest);
  await admin.query(`UPDATE poll_state SET last_contact_at = $1::timestamptz - interval '60 seconds'`, [AS_OF]);
});

const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
type Hex = { properties: { sites: number; country: string; approximate: boolean; siteIds: string[] } };
type Gap = { properties: { cell: string; kind: string } };
const cellOf = async (siteId: string, res: number) =>
  (await admin.query(`SELECT h3_latlng_to_cell(location::geometry, $2)::text AS cell FROM sites WHERE site_id = $1`, [siteId, res])).rows[0].cell as string;

describe('density on the hexagon grid', () => {
  it('counts every placed site once, and lists the unplaced ones apart', async () => {
    const r = (await get('/v1/coverage', platform)).json();
    const placed = r.hexes.features.reduce((n: number, f: Hex) => n + f.properties.sites, 0);
    expect(placed).toBe(47);
    expect(r.unplacedSites).toBe(3);
    expect(r.countries.map((c: { country: string }) => c.country).sort()).toEqual(['DE', 'IN']);
  });

  it("shows an operator only its own network's cells and areas", async () => {
    const cov = (await get('/v1/coverage', acme)).json();
    const map = (await get('/v1/map/sites', acme)).json();
    expect(cov.hexes.features.every((f: Hex) => f.properties.country === 'IN')).toBe(true);
    expect(cov.hexes.features.reduce((n: number, f: Hex) => n + f.properties.sites, 0)).toBe(map.features.length);
    const blr = cov.areas.find((a: { name: string }) => a.name === 'Bengaluru');
    expect(blr.chargersPer1000Km2).toBeGreaterThan(0);
    const gaps = (await get('/v1/coverage/gaps', stadtwerke)).json();
    expect(gaps.clusters.every((c: { country: string }) => c.country === 'DE')).toBe(true);
  });

  it('refuses cells finer than a postal-area pin can support', async () => {
    const r = await get('/v1/coverage?res=7', acme);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/false precision/);
  });

  it('flags cells whose pins are only postal-area centres', async () => {
    const pilotOnly = (await get('/v1/coverage?include_synthetic=false', acme)).json();
    expect(pilotOnly.hexes.features.map((f: Hex) => f.properties.approximate)).toEqual([false, false]); // landmark pins
    const all = (await get('/v1/coverage', acme)).json();
    expect(all.hexes.features.some((f: Hex) => f.properties.approximate)).toBe(true);
  });
});

describe('coverage gaps follow live status', () => {
  const gapKind = async (siteId: string) => {
    const cell = await cellOf(siteId, 7);
    const r = (await get('/v1/coverage/gaps', acme)).json();
    return r.gaps.features.find((f: Gap) => f.properties.cell === cell)?.properties.kind ?? 'covered';
  };

  it('marks the faulted Bengaluru site as a live gap, and Noida as covered', async () => {
    expect(await gapKind('S-IN-0012')).toBe('live'); // chargers close by, none free and working
    expect(await gapKind('S-IN-0007')).toBe('covered'); // two free connectors
    const r = (await get('/v1/coverage/gaps', acme)).json();
    expect(r.note).toMatch(/Supply only/);
  });

  it('turns a covered cell into a live gap when its site goes quiet', async () => {
    await admin.query(`UPDATE poll_state SET last_contact_at = $1::timestamptz - interval '2 hours' WHERE site_id = 'S-IN-0007'`, [AS_OF]);
    expect(await gapKind('S-IN-0007')).toBe('live');
  });

  it('rejects an out-of-range distance', async () => {
    expect((await get('/v1/coverage/gaps?max_km=0', acme)).statusCode).toBe(400);
  });
});
