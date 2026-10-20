import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { StaticSecretProvider } from '../../src/archive/aws.js';
import { issueToken } from '../../src/api/auth.js';
import { buildServer } from '../../src/api/server.js';
import { runSettlement } from '../../src/billing/settlement.js';
import { fixedClock } from '../../src/clock.js';
import { withTenant } from '../../src/db/pool.js';
import { STUBS, stub } from '../helpers/fixtures.js';
import { drain, enqueue, pools, resetDb } from './db.js';

// The exceptions queue: the operator resolves the two sessions billing held on
// 9 June (sess-in-44a: implausible energy; sess-in-77c: meter reset), the
// database keeps it to the operator's own sessions, and the day's statement is
// re-issued.

const JWT = 'test-jwt-secret';
const NOW = '2026-06-11T06:00:00Z'; // both local days of 9 June have ended
const DAY = '2026-06-09';
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
    clock: fixedClock(NOW),
    jwtSecret: JWT,
    demoMode: false,
    staleAfterSec: 300,
    billing: { tolerance: 1.1, graceSec: 7200 },
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
  for (const s of [STUBS.page1, STUBS.page2]) await enqueue(ingest, 'poll', stub(s));
  for (const s of [STUBS.webhookNormal, STUBS.webhookOutOfOrder, STUBS.webhookMeterReset]) await enqueue(ingest, 'webhook', stub(s));
  await drain(ingest);
  // The day is in: every site reported past local midnight. Settle v1 first.
  await admin.query(`UPDATE poll_state SET high_water_mark = $1, last_contact_at = $1`, [NOW]);
  const v1 = await runSettlement(ingest, 'acme-charge', DAY, { now: new Date(NOW), graceSec: 7200 });
  expect(v1).toMatchObject({ status: 'created', statement: { version: 1, sessionCount: 0, heldCount: 2 } });
});

const review = (sessionId: string, body: unknown, token: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/sessions/csms-main/${sessionId}/review`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
const latestStatement = async () =>
  (await admin.query(`SELECT * FROM settlement_statements WHERE operator_id = 'acme-charge' AND business_date = $1 ORDER BY version DESC LIMIT 1`, [DAY]))
    .rows[0];

describe('resolving a held session', () => {
  it('bills a confirmed amount and re-issues the statement as v2', async () => {
    const r = await review('sess-in-44a', { action: 'bill', energyKwh: 7.5, note: 'Charger log shows 7.5 kWh delivered' }, acme);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ billingStatus: 'charged', review: { tariffBasis: 'session_start' }, statement: { status: 'created', version: 2 } });
    const charge = (await admin.query(`SELECT energy_wh, total_amount::text FROM charges WHERE session_id = 'sess-in-44a'`)).rows[0];
    expect(charge).toEqual({ energy_wh: 7500, total_amount: '160.00' }); // 7.5 kWh x ₹18 + ₹25
    expect(await latestStatement()).toMatchObject({ version: 2, session_count: 1, held_count: 1, voided_count: 0, total_amount: '160.00' });
  });

  it('bills a session that has no start at the tariff in force at its stop', async () => {
    const r = await review('sess-in-77c', { action: 'bill', energyKwh: 20, note: 'Meter replaced; reading from the swap report' }, acme);
    expect(r.json()).toMatchObject({ billingStatus: 'charged', review: { tariffBasis: 'session_stop' } });
    expect((await admin.query(`SELECT total_amount::text FROM charges WHERE session_id = 'sess-in-77c'`)).rows[0].total_amount).toBe('385.00');
  });

  it('voids a session: no charge, and v2 moves it from held to voided', async () => {
    const r = await review('sess-in-77c', { action: 'void', note: 'Meter fault confirmed; customer not charged' }, acme);
    expect(r.json()).toMatchObject({ billingStatus: 'voided', statement: { status: 'created', version: 2 } });
    expect((await admin.query(`SELECT count(*)::int AS n FROM charges WHERE session_id = 'sess-in-77c'`)).rows[0].n).toBe(0);
    expect(await latestStatement()).toMatchObject({ version: 2, session_count: 0, held_count: 1, voided_count: 1 });
    expect((await runSettlement(ingest, 'acme-charge', DAY, { now: new Date(NOW), graceSec: 7200 })).status).toBe('unchanged');
    const audit = (await admin.query(`SELECT subject, detail FROM audit_log WHERE action LIKE 'POST /v1/sessions/%'`)).rows;
    expect(audit).toMatchObject([{ subject: 't-acme', detail: { sessionId: 'sess-in-77c', action: 'void' } }]);
  });

  it('keeps a voided session voided when its start arrives late', async () => {
    await review('sess-in-77c', { action: 'void', note: 'Meter fault confirmed; customer not charged' }, acme);
    const start = { type: 'session', event: 'session.start', charger_id: 'C-IN-0012-A', connector_id: '1', session_id: 'sess-in-77c', start_meter_wh: 12044990, ts: '2026-06-09T17:55:00+05:30' };
    await enqueue(ingest, 'webhook', { delivery_id: 'dlv-late', events: [start] });
    await drain(ingest);
    const s = (await admin.query(`SELECT billing_status, started_at FROM sessions WHERE session_id = 'sess-in-77c'`)).rows[0];
    expect(s.billing_status).toBe('voided');
    expect(s.started_at).not.toBeNull(); // the fact is kept
    const outcome = (await admin.query(`SELECT reason FROM ingest_outcomes WHERE delivery_ref = 'dlv-late'`)).rows[0];
    expect(outcome.reason).toMatch(/resolved by operator review/);
  });
});

describe('who may resolve it', () => {
  it('is the owning operator only: GridWatch staff get 403, another operator 404', async () => {
    expect((await review('sess-in-44a', { action: 'void', note: 'checked it' }, platform)).statusCode).toBe(403);
    expect((await review('sess-in-44a', { action: 'void', note: 'checked it' }, stadtwerke)).statusCode).toBe(404);
  });

  it('refuses a second decision, and an amount the charger could not deliver', async () => {
    const tooMuch = await review('sess-in-44a', { action: 'bill', energyKwh: 11.667, note: 'billing as reported' }, acme);
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().error).toMatch(/more than this charger can deliver/);
    expect((await review('sess-in-44a', { action: 'void', note: 'start register wrong' }, acme)).statusCode).toBe(200);
    expect((await review('sess-in-44a', { action: 'void', note: 'start register wrong' }, acme)).statusCode).toBe(409);
  });

  it('is enforced by the database, not only the endpoint', async () => {
    const asStadtwerke = { subject: 't-stw', role: 'operator' as const, operatorId: 'stadtwerke-ev' };
    const changed = await withTenant(api, asStadtwerke, (c) =>
      c.query(`UPDATE sessions SET billing_status = 'voided' WHERE session_id = 'sess-in-44a'`),
    );
    expect(changed.rowCount).toBe(0); // another operator's row is invisible
    await expect(
      withTenant(api, { subject: 't-acme', role: 'operator', operatorId: 'acme-charge' }, (c) =>
        c.query(`UPDATE sessions SET stop_meter_wh = 0 WHERE session_id = 'sess-in-44a'`),
      ),
    ).rejects.toThrow(/permission denied/); // only the review columns are writable
  });
});
