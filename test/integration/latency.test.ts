import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshnessReport } from '../../src/api/freshness.js';
import { withTenant } from '../../src/db/pool.js';
import { metrics } from '../../src/observability/metrics.js';
import { STUBS, stub } from '../helpers/fixtures.js';
import { drain, enqueue, pools, resetDb } from './db.js';

// The receipt -> committed SLI measures what people wait for. An event that
// deep reconciliation recovers was already minutes late at the vendor; its
// bulk re-read must not count, or a routine reconciliation pages someone.

const { admin, ingest, api } = pools();
afterAll(async () => {
  await Promise.all([admin.end(), ingest.end(), api.end()]);
});
beforeEach(async () => {
  await resetDb(admin);
});

const histogramCount = async () =>
  (await metrics.pipelineLatency.get()).values.filter((v) => v.metricName === 'gridwatch_pipeline_latency_seconds_count').reduce((n, v) => n + v.value, 0);
const missedCount = async () => (await metrics.reconciliationMissed.get()).values.reduce((n, v) => n + v.value, 0);

describe('the receipt -> committed latency SLI', () => {
  it('times fresh events, and leaves out events recovered by reconciliation', async () => {
    const [countBefore, missedBefore] = [await histogramCount(), await missedCount()];

    await enqueue(ingest, 'poll', stub(STUBS.page1)); // the normal path
    // Reconciliation re-read, received 30 s ago and processed only now,
    // carrying one event the normal path never saw.
    const missed = { type: 'status', charger_id: 'C-IN-0007-A', connector_id: '2', status: 'Available', ts: '2026-06-09T14:40:00+05:30' };
    await enqueue(ingest, 'poll', { site_id: 'S-IN-0007', server_time: '2026-06-09T09:15:00Z', events: [missed] }, 'reconcile:S-IN-0007#late:p1');
    await admin.query(`UPDATE csms_inbox SET received_at = now() - interval '30 seconds' WHERE delivery_ref LIKE 'reconcile:%'`);
    await drain(ingest);

    const outcomes = (await admin.query(`SELECT delivery_ref, outcome FROM ingest_outcomes WHERE outcome IN ('applied', 'held')`)).rows;
    const fresh = outcomes.filter((o) => !o.delivery_ref.startsWith('reconcile:')).length;
    expect(outcomes.some((o) => o.delivery_ref.startsWith('reconcile:'))).toBe(true); // the missed event was applied
    expect(fresh).toBeGreaterThan(0);

    // Prometheus: one observation per fresh event; the recovered one is counted as missed instead.
    expect((await histogramCount()) - countBefore).toBe(fresh);
    expect((await missedCount()) - missedBefore).toBe(1);

    // /v1/freshness: the same rule, so the 30 s re-read doesn't show as our latency.
    const report = await withTenant(api, { subject: 't', role: 'platform_admin', operatorId: null }, (c) => freshnessReport(c, true));
    expect(report.platform.events).toBe(fresh);
    expect(report.platform.maxSec!).toBeLessThan(5);
  });
});
