import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { processPending } from '../../src/ingest/processor.js';
import { runSettlement } from '../../src/billing/settlement.js';
import { STUBS, stub } from '../helpers/fixtures.js';
import { drain, enqueue, pools, processorOptions, resetDb } from './db.js';

// Correctness under the vendor's delivery guarantees, against a real
// Postgres/TimescaleDB: duplicates, reordering, malformed events, meter resets,
// implausible energy, and local business days.

const { admin, ingest } = pools();
afterAll(async () => {
  await Promise.all([admin.end(), ingest.end()]);
});
beforeEach(async () => {
  await resetDb(admin);
});

// The stub scenario in the order the dashboard design shows it.
async function playStubScenario() {
  await enqueue(ingest, 'poll', stub(STUBS.page1));
  await enqueue(ingest, 'poll', stub(STUBS.page2));
  await enqueue(ingest, 'poll', stub(STUBS.malformed));
  await enqueue(ingest, 'webhook', stub(STUBS.webhookNormal));
  await enqueue(ingest, 'webhook', stub(STUBS.webhookDuplicate));
  await enqueue(ingest, 'webhook', stub(STUBS.webhookOutOfOrder));
  await enqueue(ingest, 'webhook', stub(STUBS.webhookMeterReset));
  const { _note, ...faultPage } = stub(STUBS.pilotFaultPage);
  await enqueue(ingest, 'poll', faultPage);
  await drain(ingest);
}

async function connector(chargerId: string, connectorId: string) {
  return (
    await admin.query(
      `SELECT status, status_ts, active_fault_code, active_fault_severity FROM connector_state
        WHERE charger_id = $1 AND connector_id = $2`,
      [chargerId, connectorId],
    )
  ).rows[0];
}

async function session(id: string) {
  return (await admin.query(`SELECT * FROM sessions WHERE session_id = $1`, [id])).rows[0];
}

describe('acceptance: the stub scenario produces the outcome table from the dashboard design', () => {
  it('records exactly these 16 outcomes, in order', async () => {
    await playStubScenario();
    const rows = (
      await admin.query(`SELECT event_type, charger_id, connector_id, outcome FROM ingest_outcomes ORDER BY outcome_id`)
    ).rows.map((r) => `${r.event_type} ${r.charger_id}/${r.connector_id ?? '?'} ${r.outcome}`);
    expect(rows).toEqual([
      'status C-IN-0007-A/1 applied',
      'meter_value C-IN-0007-A/1 applied',
      'meter_value C-IN-0007-A/1 applied',
      'status C-IN-0007-B/1 applied',
      'fault C-IN-0007-A/2 applied',
      'meter_value C-DE-0003-A/1 quarantined', // energy_register_wh: null
      'status C-DE-0003-A/? quarantined', // connector_id and status missing
      'session.start C-DE-0003-A/1 applied',
      'session.stop C-DE-0003-A/1 applied', // settled once
      'session.stop C-DE-0003-A/1 duplicate', // dlv-002 redelivery
      'session.stop C-IN-0007-A/1 applied', // stop before start
      'status C-IN-0007-A/1 applied', // Available 14:33:40
      'status C-IN-0007-A/1 stale', // Charging 14:31:50 arrives later, is older
      'session.start C-IN-0007-A/1 held', // ~96 kW on a 60 kW charger
      'session.stop C-IN-0012-A/1 held', // meter reset
      'fault C-IN-0012-A/1 applied', // GroundFailure, critical
    ]);
  });

  it('ends in the right state: newest status wins, one charge, two sessions held, two events quarantined', async () => {
    await playStubScenario();
    const c71 = await connector('C-IN-0007-A', '1');
    expect(c71.status).toBe('Available');
    expect(c71.status_ts.toISOString()).toBe('2026-06-09T09:03:40.000Z'); // 14:33:40+05:30

    expect((await connector('C-IN-0012-A', '1')).active_fault_severity).toBe('critical');
    expect((await connector('C-IN-0007-A', '2')).active_fault_code).toBe('OverTemperature');

    const charges = (await admin.query(`SELECT session_id, energy_wh, total_amount::text, currency, business_date::text FROM charges`)).rows;
    // 41.420 kWh x EUR 0.59 = 24.4378 -> 24.44, + 0.49 session fee (sample tariff)
    expect(charges).toEqual([
      { session_id: 'sess-de-99x', energy_wh: 41_420, total_amount: '24.93', currency: 'EUR', business_date: '2026-06-09' },
    ]);

    expect(await session('sess-in-44a')).toMatchObject({ billing_status: 'needs_review', review_reason: 'implausible_energy' });
    expect(await session('sess-in-77c')).toMatchObject({ billing_status: 'needs_review', review_reason: 'meter_reset' });
    expect((await admin.query(`SELECT count(*)::int AS n FROM quarantine`)).rows[0].n).toBe(2);
  });

  it('is idempotent: replaying every payload again changes nothing', async () => {
    await playStubScenario();
    const snapshot = async () =>
      (
        await admin.query(`
          SELECT (SELECT count(*) FROM charges) AS charges, (SELECT count(*) FROM meter_readings) AS readings,
                 (SELECT count(*) FROM status_events) AS statuses, (SELECT string_agg(status || status_ts, ',' ORDER BY charger_id, connector_id) FROM connector_state) AS state,
                 (SELECT string_agg(session_id || billing_status, ',' ORDER BY session_id) FROM sessions) AS sessions`)
      ).rows[0];
    const before = await snapshot();
    await admin.query(`UPDATE csms_inbox SET processed_at = NULL`); // simulate redelivery of everything
    await admin.query(`DELETE FROM ingest_outcomes`);
    await drain(ingest);
    expect(await snapshot()).toEqual(before);
  });
});

describe('out-of-order delivery (stub 2c)', () => {
  const events = stub(STUBS.webhookOutOfOrder).events as unknown[];
  const permutations = (xs: unknown[]): unknown[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

  async function finalState() {
    const c = await connector('C-IN-0007-A', '1');
    const s = await session('sess-in-44a');
    const n = (await admin.query(`SELECT count(*)::int AS n FROM charges`)).rows[0].n;
    return {
      status: c.status,
      statusTs: c.status_ts.toISOString(),
      startedAt: s.started_at?.toISOString(),
      stoppedAt: s.stopped_at?.toISOString(),
      billing: `${s.billing_status}/${s.review_reason}`,
      charges: n,
    };
  }
  const expected = {
    status: 'Available',
    statusTs: '2026-06-09T09:03:40.000Z',
    startedAt: '2026-06-09T08:55:02.000Z',
    stoppedAt: '2026-06-09T09:02:21.000Z',
    billing: 'needs_review/implausible_energy',
    charges: 0,
  };

  it('converges to the same state for all 24 orderings within one batch', async () => {
    for (const order of permutations(events)) {
      await resetDb(admin);
      await enqueue(ingest, 'webhook', { delivery_id: 'dlv-003', events: order });
      await drain(ingest);
      expect(await finalState()).toEqual(expected);
    }
  });

  it('converges to the same state for all 24 orderings as separate deliveries', async () => {
    for (const order of permutations(events)) {
      await resetDb(admin);
      for (const [i, ev] of order.entries()) await enqueue(ingest, 'webhook', { delivery_id: `dlv-${i}`, events: [ev] });
      await drain(ingest);
      expect(await finalState()).toEqual(expected);
    }
  });

  it('converges when two processors race on the same session', async () => {
    for (const [i, ev] of [...events, ...events].entries()) {
      await enqueue(ingest, 'webhook', { delivery_id: `dlv-${i}`, events: [ev] });
    }
    const one = { ...processorOptions, batchSize: 1 };
    const worker = async () => {
      while ((await processPending(ingest, one)) > 0) {
        /* keep going */
      }
    };
    await Promise.all([worker(), worker()]);
    expect(await finalState()).toEqual(expected);
  });
});

describe('billing hazards', () => {
  it('a redelivered session.stop never bills twice (stubs 2a + 2b, then 2a again)', async () => {
    for (const s of [STUBS.webhookNormal, STUBS.webhookDuplicate, STUBS.webhookNormal]) {
      await enqueue(ingest, 'webhook', stub(s), `${stub(s).delivery_id}-${Math.random()}`);
    }
    await drain(ingest);
    const charges = (await admin.query(`SELECT count(*)::int AS n, sum(total_amount)::text AS total FROM charges`)).rows[0];
    expect(charges).toEqual({ n: 1, total: '24.93' });
  });

  it('meter reset with interval readings around it: energy is rebuilt and billed', async () => {
    // C-IN-0012-A (22 kW). Readings bracket a reset at ~18:10:30 within 30 s.
    await enqueue(ingest, 'poll', {
      site_id: 'S-IN-0012',
      server_time: '2026-06-09T18:41:00+05:30',
      events: [
        { type: 'meter_value', charger_id: 'C-IN-0012-A', connector_id: '1', energy_register_wh: 12_047_990, power_w: 18_000, ts: '2026-06-09T18:10:00+05:30' },
        { type: 'meter_value', charger_id: 'C-IN-0012-A', connector_id: '1', energy_register_wh: 500, power_w: 18_000, ts: '2026-06-09T18:10:30+05:30' },
        { type: 'meter_value', charger_id: 'C-IN-0012-A', connector_id: '1', energy_register_wh: 6_500, power_w: 18_000, ts: '2026-06-09T18:30:00+05:30' },
      ],
    });
    await enqueue(ingest, 'webhook', {
      delivery_id: 'dlv-reset',
      events: [
        { type: 'session', event: 'session.start', charger_id: 'C-IN-0012-A', connector_id: '1', session_id: 'sess-reset', start_meter_wh: 12_044_990, ts: '2026-06-09T18:00:00+05:30' },
        { type: 'session', event: 'session.stop', charger_id: 'C-IN-0012-A', connector_id: '1', session_id: 'sess-reset', start_meter_wh: 12_044_990, stop_meter_wh: 9_000, ts: '2026-06-09T18:40:12+05:30' },
      ],
    });
    await drain(ingest);
    expect(await session('sess-reset')).toMatchObject({ billing_status: 'charged', energy_wh: 12_000, energy_method: 'reset_reconstructed' });
    // 12.000 kWh x INR 18 = 216.00 + 25.00 session fee (sample tariff)
    const charge = (await admin.query(`SELECT total_amount::text AS t FROM charges WHERE session_id = 'sess-reset'`)).rows[0];
    expect(charge.t).toBe('241.00');
  });

  it('sess-in-77c without readings is held, never billed negative', async () => {
    await enqueue(ingest, 'webhook', stub(STUBS.webhookMeterReset));
    await drain(ingest);
    expect(await session('sess-in-77c')).toMatchObject({ billing_status: 'needs_review', energy_wh: null });
    expect((await admin.query(`SELECT count(*)::int AS n FROM charges`)).rows[0].n).toBe(0);
  });
});

describe('daily settlement on the local business day', () => {
  const settle = (op: string, date: string, now: string) =>
    runSettlement(ingest, op, date, { now: new Date(now), graceSec: 7_200 });

  it('a 02:00 IST run is too early for Germany: the Berlin day has not ended', async () => {
    await playStubScenario();
    await admin.query(`UPDATE poll_state SET high_water_mark = '2026-06-11T00:00:00Z'`);
    // 02:00 IST on 10 June = 22:30 CEST on 9 June.
    const r = await settle('stadtwerke-ev', '2026-06-09', '2026-06-10T02:00:00+05:30');
    expect(r.status).toBe('not_ready');
  });

  it('waits for the poll watermark, then settles; re-running is idempotent; late data makes version 2', async () => {
    await playStubScenario();
    const notYet = await settle('stadtwerke-ev', '2026-06-09', '2026-06-11T00:00:00Z');
    expect(notYet.status).toBe('not_ready'); // sites never polled past the end of the day

    await admin.query(`UPDATE poll_state SET high_water_mark = '2026-06-11T00:00:00Z'`);
    const first = await settle('stadtwerke-ev', '2026-06-09', '2026-06-11T00:00:00Z');
    expect(first).toMatchObject({ status: 'created', statement: { version: 1, sessionCount: 1, totalAmount: '24.93', heldCount: 0 } });
    const again = await settle('stadtwerke-ev', '2026-06-09', '2026-06-11T00:00:00Z');
    expect(again).toMatchObject({ status: 'unchanged', statement: { version: 1 } });

    const acme = await settle('acme-charge', '2026-06-09', '2026-06-11T00:00:00Z');
    expect(acme).toMatchObject({ status: 'created', statement: { sessionCount: 0, totalAmount: '0', heldCount: 2 } });

    // Stops at 00:30 CEST on 10 June: that is 9 June in UTC, but 10 June in Berlin.
    await enqueue(ingest, 'webhook', {
      delivery_id: 'dlv-midnight',
      events: [
        { type: 'session', event: 'session.start', charger_id: 'C-DE-0003-A', connector_id: '2', session_id: 'sess-midnight', start_meter_wh: 5_000_000, ts: '2026-06-09T23:50:00+02:00' },
        { type: 'session', event: 'session.stop', charger_id: 'C-DE-0003-A', connector_id: '2', session_id: 'sess-midnight', start_meter_wh: 5_000_000, stop_meter_wh: 5_030_000, ts: '2026-06-10T00:30:00+02:00' },
      ],
    });
    await drain(ingest);
    const day = (await admin.query(`SELECT business_date::text AS d FROM charges WHERE session_id = 'sess-midnight'`)).rows[0];
    expect(day.d).toBe('2026-06-10');
    expect((await settle('stadtwerke-ev', '2026-06-09', '2026-06-11T00:00:00Z')).status).toBe('unchanged');

    // A late session that does belong to 9 June: the statement is re-issued, not edited.
    await enqueue(ingest, 'webhook', {
      delivery_id: 'dlv-late',
      events: [
        { type: 'session', event: 'session.start', charger_id: 'C-DE-0003-A', connector_id: '2', session_id: 'sess-late', start_meter_wh: 6_000_000, ts: '2026-06-09T21:00:00+02:00' },
        { type: 'session', event: 'session.stop', charger_id: 'C-DE-0003-A', connector_id: '2', session_id: 'sess-late', start_meter_wh: 6_000_000, stop_meter_wh: 6_020_000, ts: '2026-06-09T21:30:00+02:00' },
      ],
    });
    await drain(ingest);
    const v2 = await settle('stadtwerke-ev', '2026-06-09', '2026-06-11T00:00:00Z');
    expect(v2).toMatchObject({ status: 'created', statement: { version: 2, sessionCount: 2 } });
    const versions = (await admin.query(`SELECT version FROM settlement_statements WHERE operator_id = 'stadtwerke-ev' ORDER BY version`)).rows;
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });
});
