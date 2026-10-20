import type { Client } from '../db/pool.js';

// The contract KPIs, and what the vendor interface allows. Verdicts are
// structural (they follow from the interface contract), not statistical: a
// handful of stub events can't establish a P99.9. Measured numbers are shown
// alongside as evidence, split into vendor-attributable and our own.
export const KPIS = [
  {
    key: 'status',
    signal: 'Connector / charger status',
    targetSec: 5,
    percentile: 'P99.9',
    eventTypes: ['status'],
    vendorFloor: 'Webhook batches can hold events up to 60 s; polls are at most every 30 s.',
    verdict: 'missed_at_source',
  },
  {
    key: 'power',
    signal: 'Active session power & energy',
    targetSec: 10,
    percentile: 'P99.9',
    eventTypes: ['meter_value'],
    vendorFloor: 'Chargers read power about every 10 s, but readings reach us only by poll, at most every 30 s per site, so the newest can be up to ~40 s old.',
    verdict: 'missed_at_source',
  },
  {
    key: 'fault',
    signal: 'Fault / alarm surfaced',
    targetSec: 5,
    percentile: 'P99.9',
    eventTypes: ['fault'],
    vendorFloor: 'Webhook batches can hold events up to 60 s; polls are at most every 30 s.',
    verdict: 'missed_at_source',
  },
  {
    key: 'map',
    signal: 'Map live-status update',
    targetSec: 10,
    percentile: 'P95',
    eventTypes: ['status'],
    vendorFloor: 'Same feed as status.',
    verdict: 'missed_at_source',
  },
  {
    key: 'tile',
    signal: 'Dashboard tile end-to-end',
    targetSec: 2,
    percentile: 'P99.9',
    eventTypes: [] as string[],
    vendorFloor: 'None: receipt to screen happens inside GridWatch.',
    verdict: 'ours',
  },
] as const;

interface VendorStats {
  event_type: string;
  poll_n: number;
  poll_min: number | null;
  poll_max: number | null;
  webhook_n: number;
  webhook_p50: number | null;
}

// Synthetic demo sites are excluded by default: their timestamps are generated
// by the fake vendor. Both measurements cover the most recent WINDOW events,
// so they describe now, not the whole history of a long-running demo.
const WINDOW = 20_000;

export interface RenderStats {
  n: number;
  p50Sec: number | null;
  p95Sec: number | null;
  p999Sec: number | null;
}
// A P99.9 claim needs enough samples for its tail to mean something.
const MIN_RENDER_SAMPLES = 1000;

export async function freshnessReport(c: Client, includeSynthetic = false, render: RenderStats = { n: 0, p50Sec: null, p95Sec: null, p999Sec: null }) {
  const vendor = (
    await c.query<VendorStats>(
      `SELECT o.event_type,
              count(*) FILTER (WHERE o.source = 'poll' AND o.server_time IS NOT NULL)::int AS poll_n,
              min(extract(epoch FROM o.server_time - o.event_ts)) FILTER (WHERE o.source = 'poll')::float8 AS poll_min,
              max(extract(epoch FROM o.server_time - o.event_ts)) FILTER (WHERE o.source = 'poll')::float8 AS poll_max,
              count(*) FILTER (WHERE o.source = 'webhook')::int AS webhook_n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o.received_at - o.event_ts))
                FILTER (WHERE o.source = 'webhook')::float8 AS webhook_p50
         FROM (SELECT * FROM ingest_outcomes
                WHERE ($1 OR NOT synthetic) AND event_ts IS NOT NULL
                  -- Re-reads (duplicates) say how often we asked, not how old the vendor's data was.
                  AND outcome IN ('applied', 'held', 'stale')
                ORDER BY outcome_id DESC LIMIT $2) o
        GROUP BY o.event_type`,
      [includeSynthetic, WINDOW],
    )
  ).rows;
  const platform = (
    await c.query<{ n: number; p: number[] | null; max: number | null }>(
      `SELECT count(*)::int AS n,
              percentile_cont(ARRAY[0.5, 0.99, 0.999]) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - received_at)) AS p,
              max(extract(epoch FROM processed_at - received_at))::float8 AS max
         FROM (SELECT processed_at, received_at FROM ingest_outcomes
                WHERE outcome IN ('applied', 'held')
                  -- Events recovered by deep reconciliation are excluded, as in
                  -- the Prometheus SLI: nobody was waiting on their re-read.
                  AND coalesce(delivery_ref, '') NOT LIKE 'reconcile:%'
                ORDER BY outcome_id DESC LIMIT $1) o`,
      [WINDOW],
    )
  ).rows[0];

  const byType = new Map(vendor.map((v) => [v.event_type, v]));
  const platformStats = {
    events: platform?.n ?? 0,
    p50Sec: platform?.p?.[0] ?? null,
    p99Sec: platform?.p?.[1] ?? null,
    p999Sec: platform?.p?.[2] ?? null,
    maxSec: platform?.max ?? null,
    measures: 'receipt at the GridWatch edge -> state committed',
  };

  return {
    platform: platformStats,
    signals: KPIS.map((k) => {
      const stats = k.eventTypes.map((t) => byType.get(t)).filter((v): v is VendorStats => !!v);
      const pollN = stats.reduce((a, s) => a + s.poll_n, 0);
      const mins = stats.map((s) => s.poll_min).filter((v): v is number => v !== null);
      const maxs = stats.map((s) => s.poll_max).filter((v): v is number => v !== null);
      const webhookP50 = stats.map((s) => s.webhook_p50).find((v) => v !== null) ?? null;
      // The tile KPI is judged on what screens report (receipt -> drawn),
      // not on receipt -> committed, which leaves out the push and the render.
      let verdict: string = k.verdict;
      if (k.verdict === 'ours') {
        verdict =
          render.n === 0
            ? 'ours_no_data'
            : render.n < MIN_RENDER_SAMPLES
              ? 'ours_measuring'
              : render.p999Sec !== null && render.p999Sec < k.targetSec
                ? 'ours_met'
                : 'ours_at_risk';
      }
      return {
        key: k.key,
        signal: k.signal,
        targetSec: k.targetSec,
        percentile: k.percentile,
        vendorFloor: k.vendorFloor,
        verdict,
        vendorAgeWhenServed:
          pollN > 0 ? { samples: pollN, minSec: Math.min(...mins), maxSec: Math.max(...maxs), measures: 'poll server_time - event time' } : null,
        webhookReceiptLagP50Sec: webhookP50,
        // Stub payloads are dated June 2026 and replayed now, so receipt lag on
        // them is months: flagged rather than presented as a measurement.
        webhookLagIsReplay: webhookP50 !== null && webhookP50 > 86_400,
        ...(k.verdict === 'ours' ? { render: { ...render, minSamplesForP999: MIN_RENDER_SAMPLES, measures: 'receipt at the GridWatch edge -> drawn on a dashboard screen' } } : {}),
      };
    }),
  };
}
