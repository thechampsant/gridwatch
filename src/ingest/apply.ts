import type { Client } from '../db/pool.js';
import { evaluateSessionEnergy, type EnergyOptions, type Reading } from '../billing/energy.js';
import { formatLocalTime, secondsBetween } from '../util/time.js';
import type { NormalizedEvent } from './normalize.js';

// Applying one normalised event to the store. Every function here is safe to
// run twice and in any order relative to other events:
//   - telemetry rows are keyed by natural keys that include event time
//     (ON CONFLICT DO NOTHING), so redeliveries are no-ops;
//   - live state only moves forward in event time, never in arrival time;
//   - sessions merge start/stop commutatively under a row lock;
//   - charges are UNIQUE per session, so billing happens at most once.

export type OutcomeKind = 'applied' | 'stale' | 'duplicate' | 'quarantined' | 'held';
export interface Outcome {
  outcome: OutcomeKind;
  reason: string;
  // set when the event itself must go to the dead-letter store
  quarantine?: { reason: string; detail: string };
}

export interface ChargerInfo {
  chargerId: string;
  operatorId: string;
  siteId: string;
  connectionId: string;
  maxKw: number;
  timezone: string;
  connectors: string[];
}

export interface ApplyContext {
  source: 'webhook' | 'poll';
  receivedAt: Date;
  serverTime: Date | null;
  charger: ChargerInfo;
  energy: EnergyOptions;
}

export async function applyEvent(c: Client, ev: NormalizedEvent, ctx: ApplyContext): Promise<Outcome> {
  switch (ev.kind) {
    case 'status':
      return applyStatus(c, ev, ctx);
    case 'meter':
      return applyMeter(c, ev, ctx);
    case 'fault':
      return applyFault(c, ev, ctx);
    case 'session_start':
    case 'session_stop':
      return applySession(c, ev, ctx);
  }
}

type Ev<K extends NormalizedEvent['kind']> = Extract<NormalizedEvent, { kind: K }>;

const at = (d: Date, ctx: ApplyContext) => formatLocalTime(d, ctx.charger.timezone);

async function applyStatus(c: Client, ev: Ev<'status'>, ctx: ApplyContext): Promise<Outcome> {
  const { charger } = ctx;
  const prev = (
    await c.query<{ status: string | null; status_ts: Date | null }>(
      `SELECT status, status_ts FROM connector_state WHERE charger_id = $1 AND connector_id = $2 FOR UPDATE`,
      [ev.chargerId, ev.connectorId],
    )
  ).rows[0];

  const inserted = await c.query(
    `INSERT INTO status_events (ts, charger_id, connector_id, operator_id, status, received_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [ev.ts, ev.chargerId, ev.connectorId, charger.operatorId, ev.status, ctx.receivedAt],
  );
  if (inserted.rowCount === 0) return { outcome: 'duplicate', reason: 'Same status event already recorded.' };

  // Newest event time wins, not last received. Equal timestamps: the more
  // severe status wins (status_rank), so the result is order-independent.
  // A newer non-Faulted status clears an older fault.
  const updated = await c.query(
    `INSERT INTO connector_state AS cs (charger_id, connector_id, operator_id, site_id, status, status_ts, status_received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (charger_id, connector_id) DO UPDATE SET
       status = EXCLUDED.status,
       status_ts = EXCLUDED.status_ts,
       status_received_at = EXCLUDED.status_received_at,
       active_fault_code     = CASE WHEN EXCLUDED.status <> 'Faulted' AND cs.active_fault_ts < EXCLUDED.status_ts
                                    THEN NULL ELSE cs.active_fault_code END,
       active_fault_severity = CASE WHEN EXCLUDED.status <> 'Faulted' AND cs.active_fault_ts < EXCLUDED.status_ts
                                    THEN NULL ELSE cs.active_fault_severity END,
       active_fault_ts       = CASE WHEN EXCLUDED.status <> 'Faulted' AND cs.active_fault_ts < EXCLUDED.status_ts
                                    THEN NULL ELSE cs.active_fault_ts END,
       updated_at = now()
     WHERE cs.status_ts IS NULL
        OR EXCLUDED.status_ts > cs.status_ts
        OR (EXCLUDED.status_ts = cs.status_ts AND status_rank(EXCLUDED.status) > status_rank(cs.status))`,
    [ev.chargerId, ev.connectorId, charger.operatorId, charger.siteId, ev.status, ev.ts, ctx.receivedAt],
  );

  if (updated.rowCount === 0) {
    const newer = prev?.status_ts ? ` than ${at(prev.status_ts, ctx)}` : '';
    return { outcome: 'stale', reason: `Older${newer}. Kept in history; live status unchanged.` };
  }
  if (!prev?.status_ts) return { outcome: 'applied', reason: 'First status for this connector.' };
  return { outcome: 'applied', reason: `Newer than the current status (${at(prev.status_ts, ctx)}).` };
}

async function applyMeter(c: Client, ev: Ev<'meter'>, ctx: ApplyContext): Promise<Outcome> {
  const { charger } = ctx;
  const inserted = await c.query(
    `INSERT INTO meter_readings (ts, charger_id, connector_id, operator_id, energy_wh, power_w, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [ev.ts, ev.chargerId, ev.connectorId, charger.operatorId, ev.energyWh, ev.powerW, ctx.receivedAt],
  );
  if (inserted.rowCount === 0) {
    const existing = (
      await c.query<{ energy_wh: number }>(
        `SELECT energy_wh FROM meter_readings WHERE charger_id = $1 AND connector_id = $2 AND ts = $3`,
        [ev.chargerId, ev.connectorId, ev.ts],
      )
    ).rows[0];
    if (existing && existing.energy_wh !== ev.energyWh) {
      const detail = `A reading for this connector and timestamp is already stored with ${existing.energy_wh} Wh; this one says ${ev.energyWh} Wh. Kept the first.`;
      return { outcome: 'quarantined', reason: detail, quarantine: { reason: 'conflicting_duplicate', detail } };
    }
    return { outcome: 'duplicate', reason: 'Same reading already stored.' };
  }

  await c.query(
    `INSERT INTO connector_state AS cs (charger_id, connector_id, operator_id, site_id, power_w, energy_wh, meter_ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (charger_id, connector_id) DO UPDATE SET
       power_w = EXCLUDED.power_w, energy_wh = EXCLUDED.energy_wh, meter_ts = EXCLUDED.meter_ts, updated_at = now()
     WHERE cs.meter_ts IS NULL OR EXCLUDED.meter_ts > cs.meter_ts`,
    [ev.chargerId, ev.connectorId, charger.operatorId, charger.siteId, ev.powerW, ev.energyWh, ev.ts],
  );

  const prev = (
    await c.query<{ energy_wh: number }>(
      `SELECT energy_wh FROM meter_readings
        WHERE charger_id = $1 AND connector_id = $2 AND ts < $3
        ORDER BY ts DESC LIMIT 1`,
      [ev.chargerId, ev.connectorId, ev.ts],
    )
  ).rows[0];
  if (!prev) return { outcome: 'applied', reason: 'Lifetime register stored as-is; energy is always a difference.' };
  const step = ev.energyWh - prev.energy_wh;
  if (step >= 0) return { outcome: 'applied', reason: `+${step.toLocaleString('en-US')} Wh since the previous reading.` };
  return {
    outcome: 'applied',
    reason: `Register dropped ${(-step).toLocaleString('en-US')} Wh since the previous reading: reset or meter swap. Stored; billing rebuilds across it.`,
  };
}

async function applyFault(c: Client, ev: Ev<'fault'>, ctx: ApplyContext): Promise<Outcome> {
  const { charger } = ctx;
  const inserted = await c.query(
    `INSERT INTO fault_events (ts, charger_id, connector_id, operator_id, code, severity, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [ev.ts, ev.chargerId, ev.connectorId, charger.operatorId, ev.code, ev.severity, ctx.receivedAt],
  );
  if (inserted.rowCount === 0) return { outcome: 'duplicate', reason: 'Same fault already recorded.' };

  // The feed has no "fault cleared" event: a fault stays active until a later
  // status that isn't Faulted. A fault older than the current status is history.
  const active = await c.query(
    `INSERT INTO connector_state AS cs (charger_id, connector_id, operator_id, site_id,
                                       active_fault_code, active_fault_severity, active_fault_ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (charger_id, connector_id) DO UPDATE SET
       active_fault_code = EXCLUDED.active_fault_code,
       active_fault_severity = EXCLUDED.active_fault_severity,
       active_fault_ts = EXCLUDED.active_fault_ts,
       updated_at = now()
     WHERE (cs.status_ts IS NULL OR EXCLUDED.active_fault_ts >= cs.status_ts)
       AND (cs.active_fault_ts IS NULL OR EXCLUDED.active_fault_ts >= cs.active_fault_ts)
     RETURNING 1`,
    [ev.chargerId, ev.connectorId, charger.operatorId, charger.siteId, ev.code, ev.severity, ev.ts],
  );
  if (active.rowCount === 0) {
    return { outcome: 'applied', reason: 'Recorded in history; a later status supersedes it.' };
  }
  let reason = ev.severity === 'critical' ? 'Alert raised; connector shown as Faulted.' : 'Alert raised.';
  if (ctx.serverTime) {
    const lag = Math.round(secondsBetween(ctx.serverTime, ev.ts));
    if (lag > 5) reason += ` Already ${lag} s old when the vendor served the page.`;
  }
  return { outcome: 'applied', reason };
}

interface SessionRow {
  charger_id: string;
  connector_id: string;
  started_at: Date | null;
  stopped_at: Date | null;
  start_meter_wh: number | null;
  stop_meter_wh: number | null;
  billing_status: 'open' | 'awaiting_start' | 'charged' | 'needs_review';
}

async function applySession(
  c: Client,
  ev: Ev<'session_start'> | Ev<'session_stop'>,
  ctx: ApplyContext,
): Promise<Outcome> {
  const { charger } = ctx;
  await c.query(
    `INSERT INTO sessions (connection_id, session_id, operator_id, site_id, charger_id, connector_id)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [charger.connectionId, ev.sessionId, charger.operatorId, charger.siteId, ev.chargerId, ev.connectorId],
  );
  // Row lock: concurrent processors handling the start and the stop of the
  // same session serialise here, so the merge is race-free.
  const s = (
    await c.query<SessionRow>(
      `SELECT charger_id, connector_id, started_at, stopped_at, start_meter_wh, stop_meter_wh, billing_status
         FROM sessions WHERE connection_id = $1 AND session_id = $2 FOR UPDATE`,
      [charger.connectionId, ev.sessionId],
    )
  ).rows[0]!;

  const conflict = (detail: string): Outcome => ({
    outcome: 'quarantined',
    reason: detail,
    quarantine: { reason: 'conflicting_session_event', detail },
  });

  if (s.charger_id !== ev.chargerId || s.connector_id !== ev.connectorId) {
    return conflict(`Session ${ev.sessionId} is already recorded on ${s.charger_id}/${s.connector_id}.`);
  }
  if (s.start_meter_wh !== null && s.start_meter_wh !== ev.startMeterWh) {
    return conflict(`Start register ${ev.startMeterWh} Wh disagrees with ${s.start_meter_wh} Wh already recorded.`);
  }

  let mergedIntoStop = false;
  if (ev.kind === 'session_start') {
    if (s.started_at) {
      if (s.started_at.getTime() === ev.ts.getTime()) {
        return { outcome: 'duplicate', reason: 'Same session.start already recorded.' };
      }
      return conflict(`A different start time (${at(s.started_at, ctx)}) is already recorded.`);
    }
    mergedIntoStop = s.stopped_at !== null;
    await c.query(
      `UPDATE sessions SET started_at = $3, start_meter_wh = $4, updated_at = now()
        WHERE connection_id = $1 AND session_id = $2`,
      [charger.connectionId, ev.sessionId, ev.ts, ev.startMeterWh],
    );
    s.started_at = ev.ts;
    s.start_meter_wh = ev.startMeterWh;
  } else {
    if (s.stopped_at) {
      if (s.stopped_at.getTime() === ev.ts.getTime() && s.stop_meter_wh === ev.stopMeterWh) {
        return {
          outcome: 'duplicate',
          reason:
            s.billing_status === 'charged'
              ? 'Same session_id already settled. No second invoice.'
              : 'Same session.stop already recorded.',
        };
      }
      return conflict(`A different stop (${at(s.stopped_at, ctx)}, ${s.stop_meter_wh} Wh) is already recorded.`);
    }
    await c.query(
      `UPDATE sessions SET stopped_at = $3, stop_meter_wh = $4, start_meter_wh = coalesce(start_meter_wh, $5),
              updated_at = now()
        WHERE connection_id = $1 AND session_id = $2`,
      [charger.connectionId, ev.sessionId, ev.ts, ev.stopMeterWh, ev.startMeterWh],
    );
    s.stopped_at = ev.ts;
    s.stop_meter_wh = ev.stopMeterWh;
    s.start_meter_wh = s.start_meter_wh ?? ev.startMeterWh;
  }

  return finalizeSession(c, ev, ctx, s, mergedIntoStop);
}

async function finalizeSession(
  c: Client,
  ev: Ev<'session_start'> | Ev<'session_stop'>,
  ctx: ApplyContext,
  s: SessionRow,
  mergedIntoStop: boolean,
): Promise<Outcome> {
  const { charger } = ctx;
  const key = [charger.connectionId, ev.sessionId];
  const prefix = mergedIntoStop ? 'Merged into the session created by its stop. ' : '';

  let readings: Reading[] = [];
  const needsReadings =
    s.started_at && s.stopped_at && s.start_meter_wh !== null && s.stop_meter_wh !== null && s.stop_meter_wh < s.start_meter_wh;
  if (needsReadings) {
    readings = (
      await c.query<{ ts: Date; energy_wh: number }>(
        `SELECT ts, energy_wh FROM meter_readings
          WHERE charger_id = $1 AND connector_id = $2 AND ts > $3 AND ts < $4 ORDER BY ts`,
        [s.charger_id, s.connector_id, s.started_at, s.stopped_at],
      )
    ).rows.map((r) => ({ ts: r.ts, energyWh: r.energy_wh }));
  }

  const verdict = evaluateSessionEnergy(
    {
      startedAt: s.started_at,
      stoppedAt: s.stopped_at,
      startMeterWh: s.start_meter_wh,
      stopMeterWh: s.stop_meter_wh,
      maxKw: charger.maxKw,
    },
    readings,
    ctx.energy,
  );

  const setStatus = (status: string, reason: string | null, detail: string | null) =>
    c.query(
      `UPDATE sessions SET billing_status = $3, review_reason = $4, review_detail = $5, updated_at = now()
        WHERE connection_id = $1 AND session_id = $2`,
      [...key, status, reason, detail],
    );

  switch (verdict.kind) {
    case 'incomplete':
      if (verdict.waitingFor === 'start') {
        await setStatus('awaiting_start', null, null);
        return {
          outcome: 'applied',
          reason: 'Stop before start: session created from the stop. Billing waits for the start, which gives the duration.',
        };
      }
      await setStatus('open', null, null);
      return { outcome: 'applied', reason: 'Session opened.' };

    case 'review':
      await setStatus('needs_review', verdict.reason, verdict.detail);
      if (verdict.reason === 'meter_reset' && ev.kind === 'session_stop') {
        return { outcome: 'held', reason: 'Stop register below start register: meter reset. Not invoiced.' };
      }
      return { outcome: 'held', reason: prefix + verdict.detail };

    case 'billable': {
      await c.query(
        `UPDATE sessions SET energy_wh = $3, energy_method = $4, updated_at = now()
          WHERE connection_id = $1 AND session_id = $2`,
        [...key, verdict.energyWh, verdict.method],
      );
      // Money is computed in NUMERIC, rounded half-up to the currency's minor
      // unit. The tariff in force at session start applies. The business day
      // is the stop's local date in the site's IANA zone.
      const charged = await c.query(
        `INSERT INTO charges (connection_id, session_id, operator_id, site_id, business_date, timezone, currency,
                              energy_wh, tariff_id, price_per_kwh, session_fee, energy_amount, total_amount)
         SELECT s.connection_id, s.session_id, s.operator_id, s.site_id,
                (s.stopped_at AT TIME ZONE st.timezone)::date, st.timezone, t.currency,
                s.energy_wh, t.tariff_id, t.price_per_kwh, t.session_fee,
                round(s.energy_wh * t.price_per_kwh / 1000, 2),
                round(s.energy_wh * t.price_per_kwh / 1000, 2) + t.session_fee
           FROM sessions s
           JOIN sites st ON st.site_id = s.site_id
           JOIN LATERAL (
             SELECT * FROM tariffs
              WHERE operator_id = s.operator_id AND valid_from <= s.started_at
                AND (valid_to IS NULL OR valid_to > s.started_at)
              ORDER BY valid_from DESC LIMIT 1
           ) t ON true
          WHERE s.connection_id = $1 AND s.session_id = $2
         ON CONFLICT (connection_id, session_id) DO NOTHING
         RETURNING total_amount, currency`,
        key,
      );
      if (charged.rowCount === 0) {
        const exists = await c.query(`SELECT 1 FROM charges WHERE connection_id = $1 AND session_id = $2`, key);
        if (exists.rowCount === 0) {
          const detail = 'No tariff in force at session start. Not invoiced.';
          await setStatus('needs_review', 'no_tariff', detail);
          return { outcome: 'held', reason: prefix + detail };
        }
      }
      await setStatus('charged', null, null);
      return { outcome: 'applied', reason: prefix + verdict.note };
    }
  }
}

// Last time the vendor told us anything about this connector, by event time.
export async function touchConnector(c: Client, ev: NormalizedEvent, ctx: ApplyContext): Promise<void> {
  await c.query(
    `INSERT INTO connector_state AS cs (charger_id, connector_id, operator_id, site_id, last_seen_at, last_seen_via)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (charger_id, connector_id) DO UPDATE SET
       last_seen_via = CASE WHEN cs.last_seen_at IS NULL OR EXCLUDED.last_seen_at > cs.last_seen_at
                            THEN EXCLUDED.last_seen_via ELSE cs.last_seen_via END,
       last_seen_at = GREATEST(cs.last_seen_at, EXCLUDED.last_seen_at)`,
    [ev.chargerId, ev.connectorId, ctx.charger.operatorId, ctx.charger.siteId, ev.ts, ctx.source],
  );
}
