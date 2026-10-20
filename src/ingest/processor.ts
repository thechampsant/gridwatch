import type { Client, Pool } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { PollPage, WebhookBatch } from '../csms/schemas.js';
import type { EnergyOptions } from '../billing/energy.js';
import { metrics } from '../observability/metrics.js';
import { secondsBetween } from '../util/time.js';
import { applyEvent, touchConnector, type ApplyContext, type ChargerInfo, type Outcome } from './apply.js';
import { eventTypeOf, localTimeLabel, normalizeEvent, summarize, type PartialEvent } from './normalize.js';

export interface ProcessorOptions {
  batchSize: number;
  maxAttempts: number; // a payload that keeps failing is dead-lettered after this many tries
  futureSkewSec: number;
  energy: EnergyOptions;
}

export const defaultProcessorOptions: ProcessorOptions = {
  batchSize: 50,
  maxAttempts: 5,
  futureSkewSec: 300,
  energy: { tolerance: 1.1, resetMaxGapSec: 120 },
};

interface InboxRow {
  inbox_id: number;
  connection_id: string;
  source: 'webhook' | 'poll';
  delivery_ref: string | null;
  site_id: string | null;
  server_time: Date | null;
  received_at: Date;
  payload: unknown;
  attempts: number;
}

// Claims up to batchSize pending inbox rows and applies them. Each row runs in
// its own savepoint: one bad payload never blocks the others, and a crash
// part-way leaves the row pending (everything it did is rolled back), so it is
// simply retried. Apply is idempotent, so a retry can't double-count.
export async function processPending(pool: Pool, opts: ProcessorOptions = defaultProcessorOptions): Promise<number> {
  return withTx(pool, async (c) => {
    const { rows } = await c.query<InboxRow>(
      `SELECT inbox_id, connection_id, source, delivery_ref, site_id, server_time, received_at, payload, attempts
         FROM csms_inbox WHERE processed_at IS NULL
        ORDER BY inbox_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [opts.batchSize],
    );
    for (const row of rows) {
      await c.query('SAVEPOINT inbox_row');
      try {
        await processRow(c, row, opts);
        await c.query(`UPDATE csms_inbox SET processed_at = now(), attempts = attempts + 1 WHERE inbox_id = $1`, [
          row.inbox_id,
        ]);
        await c.query('RELEASE SAVEPOINT inbox_row');
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT inbox_row');
        const message = (err as Error).message;
        const attempts = row.attempts + 1;
        if (attempts >= opts.maxAttempts) {
          await quarantine(c, row, null, 'poison_payload', `failed ${attempts} times; last error: ${message}`, row.payload);
          await c.query(
            `UPDATE csms_inbox SET processed_at = now(), attempts = $2, last_error = $3 WHERE inbox_id = $1`,
            [row.inbox_id, attempts, message],
          );
        } else {
          await c.query(`UPDATE csms_inbox SET attempts = $2, last_error = $3 WHERE inbox_id = $1`, [
            row.inbox_id,
            attempts,
            message,
          ]);
        }
        console.error(`inbox ${row.inbox_id} failed (attempt ${attempts}): ${message}`);
      }
    }
    return rows.length;
  });
}

async function processRow(c: Client, row: InboxRow, opts: ProcessorOptions): Promise<void> {
  const envelope = row.source === 'poll' ? PollPage.safeParse(row.payload) : WebhookBatch.safeParse(row.payload);
  if (!envelope.success) {
    const detail = envelope.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    await quarantine(c, row, null, 'invalid_envelope', detail, row.payload);
    await recordOutcome(c, row, -1, {}, null, null, 'batch', `${row.source} payload`, {
      outcome: 'quarantined',
      reason: `Payload does not match the vendor contract (${detail}).`,
    });
    return;
  }

  const chargers = new Map<string, ChargerInfo | null>();
  const isReconciliation = row.delivery_ref?.startsWith('reconcile:') ?? false;
  const reference = row.server_time ?? row.received_at;

  for (const [index, raw] of envelope.data.events.entries()) {
    const n = normalizeEvent(raw);
    if (!n.ok) {
      await quarantine(c, row, index, n.reason, n.detail, raw);
      const charger = n.partial.chargerId ? await lookupCharger(c, chargers, n.partial.chargerId) : null;
      await recordOutcome(c, row, index, n.partial, charger, null, n.partial.type ?? 'unknown', invalidSummary(n.partial), {
        outcome: 'quarantined',
        reason: `${n.detail}. Sent to dead-letter; the rest of the payload was still processed.`,
      });
      metrics.quarantined.inc({ reason: n.reason });
      continue;
    }

    const ev = n.event;
    const type = eventTypeOf(ev);
    const partial: PartialEvent = { type, chargerId: ev.chargerId, connectorId: ev.connectorId, tsRaw: ev.tsRaw, ts: ev.ts };
    const charger = await lookupCharger(c, chargers, ev.chargerId);

    const reject = async (reason: string, detail: string) => {
      await quarantine(c, row, index, reason, detail, raw);
      await recordOutcome(c, row, index, partial, charger, ev.ts, type, summarize(ev), {
        outcome: 'quarantined',
        reason: detail,
      });
      metrics.quarantined.inc({ reason });
    };

    if (!charger) {
      await reject('unknown_charger', `Charger ${ev.chargerId} is not in the catalogue. Held in dead-letter until onboarded.`);
      continue;
    }
    if (charger.connectionId !== row.connection_id) {
      await reject('connection_mismatch', `Charger ${ev.chargerId} belongs to another CSMS connection. Rejected.`);
      continue;
    }
    if (row.source === 'poll' && row.site_id && charger.siteId !== row.site_id) {
      await reject('site_mismatch', `Charger ${ev.chargerId} is not at polled site ${row.site_id}. Rejected.`);
      continue;
    }
    if (!charger.connectors.includes(ev.connectorId)) {
      await reject('unknown_connector', `Connector ${ev.connectorId} is not in the catalogue for ${ev.chargerId}.`);
      continue;
    }
    if (secondsBetween(ev.ts, reference) > opts.futureSkewSec) {
      await reject(
        'future_timestamp',
        `Event time is ${Math.round(secondsBetween(ev.ts, reference))} s ahead of ${row.server_time ? 'vendor time' : 'receipt'}: charger clock is wrong.`,
      );
      continue;
    }

    const ctx: ApplyContext = {
      source: row.source,
      receivedAt: row.received_at,
      serverTime: row.server_time,
      charger,
      energy: opts.energy,
    };
    const outcome = await applyEvent(c, ev, ctx);
    if (outcome.quarantine) {
      await quarantine(c, row, index, outcome.quarantine.reason, outcome.quarantine.detail, raw);
      metrics.quarantined.inc({ reason: outcome.quarantine.reason });
    } else {
      await touchConnector(c, ev, ctx);
    }
    await recordOutcome(c, row, index, partial, charger, ev.ts, type, summarize(ev), outcome);

    metrics.events.inc({ source: row.source, type, outcome: outcome.outcome });
    if (outcome.outcome === 'applied' || outcome.outcome === 'held') {
      metrics.sourceLag.observe({ source: row.source, type }, Math.max(0, secondsBetween(reference, ev.ts)));
      metrics.pipelineLatency.observe({ type }, Math.max(0, secondsBetween(new Date(), row.received_at)));
      if (isReconciliation) metrics.reconciliationMissed.inc();
    }
  }
}

function invalidSummary(p: PartialEvent): string {
  return `${p.type ?? 'event'} · invalid`;
}

async function lookupCharger(c: Client, cache: Map<string, ChargerInfo | null>, chargerId: string) {
  if (cache.has(chargerId)) return cache.get(chargerId)!;
  const r = await c.query<{
    charger_id: string;
    operator_id: string;
    site_id: string;
    connection_id: string;
    max_kw: number;
    timezone: string;
    connectors: string[];
  }>(
    `SELECT ch.charger_id, ch.operator_id, ch.site_id, ch.connection_id, ch.max_kw::float8 AS max_kw, s.timezone,
            coalesce(array_agg(cn.connector_id) FILTER (WHERE cn.connector_id IS NOT NULL), '{}') AS connectors
       FROM chargers ch
       JOIN sites s ON s.site_id = ch.site_id
       LEFT JOIN connectors cn ON cn.charger_id = ch.charger_id
      WHERE ch.charger_id = $1
      GROUP BY ch.charger_id, s.timezone`,
    [chargerId],
  );
  const row = r.rows[0];
  const info: ChargerInfo | null = row
    ? {
        chargerId: row.charger_id,
        operatorId: row.operator_id,
        siteId: row.site_id,
        connectionId: row.connection_id,
        maxKw: row.max_kw,
        timezone: row.timezone,
        connectors: row.connectors,
      }
    : null;
  cache.set(chargerId, info);
  return info;
}

async function quarantine(
  c: Client,
  row: InboxRow,
  index: number | null,
  reason: string,
  detail: string,
  payload: unknown,
): Promise<void> {
  const chargerId =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).charger_id : undefined;
  await c.query(
    `INSERT INTO quarantine (inbox_id, event_index, connection_id, operator_id, payload, reason, detail)
     VALUES ($1, $2, $3, (SELECT operator_id FROM chargers WHERE charger_id = $4), $5, $6, $7)
     ON CONFLICT (inbox_id, event_index) DO NOTHING`,
    [row.inbox_id, index ?? -1, row.connection_id, typeof chargerId === 'string' ? chargerId : null, JSON.stringify(payload), reason, detail],
  );
}

async function recordOutcome(
  c: Client,
  row: InboxRow,
  index: number,
  p: PartialEvent,
  charger: ChargerInfo | null,
  ts: Date | null,
  type: string,
  summary: string,
  o: Outcome,
): Promise<void> {
  await c.query(
    `INSERT INTO ingest_outcomes (inbox_id, event_index, operator_id, site_id, source, delivery_ref, event_type, summary,
                                  charger_id, connector_id, event_ts_local, event_ts, outcome, reason, received_at,
                                  server_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (inbox_id, event_index) DO NOTHING`,
    [
      row.inbox_id,
      index,
      charger?.operatorId ?? null,
      charger?.siteId ?? row.site_id,
      row.source,
      row.delivery_ref,
      type,
      summary,
      p.chargerId ?? null,
      p.connectorId ?? null,
      localTimeLabel(p.tsRaw),
      ts ?? p.ts ?? null,
      o.outcome,
      o.reason,
      row.received_at,
      row.server_time,
    ],
  );
}

// Sessions that never complete are moved to review rather than left open
// forever: a stop with no start after the grace period, or a start with no
// stop after a day.
export async function sweepSessions(pool: Pool, graceSec: number): Promise<number> {
  const r = await pool.query(
    `UPDATE sessions
        SET billing_status = 'needs_review',
            review_reason = CASE billing_status WHEN 'awaiting_start' THEN 'start_missing' ELSE 'stop_missing' END,
            review_detail = CASE billing_status
              WHEN 'awaiting_start' THEN 'Stop received but no start within the grace period; duration unknown, so plausibility cannot be checked.'
              ELSE 'Start received but no stop within 24 hours.' END,
            updated_at = now()
      WHERE (billing_status = 'awaiting_start' AND first_seen_at < now() - make_interval(secs => $1))
         OR (billing_status = 'open' AND first_seen_at < now() - interval '24 hours')`,
    [graceSec],
  );
  return r.rowCount ?? 0;
}

export async function refreshBacklogGauge(pool: Pool): Promise<void> {
  const r = await pool.query<{ age: number | null }>(
    `SELECT extract(epoch FROM now() - min(received_at))::float8 AS age FROM csms_inbox WHERE processed_at IS NULL`,
  );
  metrics.inboxOldestPendingAge.set(r.rows[0]?.age ?? 0);
}
