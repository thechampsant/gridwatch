import { createHash } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import { withTx } from '../db/pool.js';

// Daily settlement per operator and LOCAL business day.
//
// - The day is the operator's IANA zone day (Asia/Kolkata, Europe/Berlin), not
//   UTC and not one global run time. A single 02:00 IST run would be 22:30 CEST
//   the previous evening, before the German day has ended.
// - It runs only once the data for that day is in: the local day has ended,
//   a grace period has passed, and every site's poll high-water mark is past
//   the end of the day (a watermark, not a wall-clock guess).
// - Statements are versioned, never edited. Re-running with the same data
//   returns the same statement; late data produces version n+1.

export interface SettlementOptions {
  now: Date;
  graceSec: number;
  force?: boolean; // skip the readiness checks (operator-triggered re-run)
}

export interface Statement {
  operatorId: string;
  businessDate: string;
  version: number;
  currency: string;
  timezone: string;
  sessionCount: number;
  energyWh: number;
  totalAmount: string;
  heldCount: number;
  checksum: string;
}

export type SettlementResult =
  | { status: 'not_ready'; reason: string }
  | { status: 'unchanged'; statement: Statement }
  | { status: 'created'; statement: Statement };

export async function runSettlement(
  pool: Pool,
  operatorId: string,
  businessDate: string,
  o: SettlementOptions,
): Promise<SettlementResult> {
  return withTx(pool, async (c) => {
    // One run per operator and day at a time.
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`settlement:${operatorId}:${businessDate}`]);

    const op = (
      await c.query<{ timezone: string; currency: string; day_end: Date; min_hwm: Date | null; unpolled: number }>(
        `SELECT o.timezone, o.currency,
                (($2::date + 1)::timestamp AT TIME ZONE o.timezone) AS day_end,
                (SELECT min(high_water_mark) FROM poll_state WHERE operator_id = o.operator_id) AS min_hwm,
                (SELECT count(*)::int FROM poll_state WHERE operator_id = o.operator_id AND high_water_mark IS NULL) AS unpolled
           FROM operators o WHERE o.operator_id = $1`,
        [operatorId, businessDate],
      )
    ).rows[0];
    if (!op) throw new Error(`unknown operator ${operatorId}`);

    if (!o.force) {
      const readyAt = new Date(op.day_end.getTime() + o.graceSec * 1000);
      if (o.now < readyAt) {
        return { status: 'not_ready', reason: `local day ends ${op.day_end.toISOString()}; ready after ${readyAt.toISOString()}` };
      }
      if (op.unpolled > 0 || !op.min_hwm || op.min_hwm < op.day_end) {
        return {
          status: 'not_ready',
          reason: `${op.unpolled} site(s) never polled or a poll high-water mark is before the end of the day; data may still be arriving`,
        };
      }
    }

    const lines = (
      await c.query<{ session_id: string; energy_wh: number; total_amount: string; currency: string }>(
        `SELECT session_id, energy_wh, total_amount::text, currency FROM charges
          WHERE operator_id = $1 AND business_date = $2 ORDER BY session_id`,
        [operatorId, businessDate],
      )
    ).rows;
    const held = (
      await c.query<{ session_id: string }>(
        `SELECT se.session_id FROM sessions se JOIN sites st ON st.site_id = se.site_id
          WHERE se.operator_id = $1 AND se.billing_status = 'needs_review'
            AND (se.stopped_at AT TIME ZONE st.timezone)::date = $2
          ORDER BY se.session_id`,
        [operatorId, businessDate],
      )
    ).rows;
    const totals = (
      await c.query<{ n: number; energy: number; total: string }>(
        `SELECT count(*)::int AS n, coalesce(sum(energy_wh), 0)::bigint AS energy, coalesce(sum(total_amount), 0)::text AS total
           FROM charges WHERE operator_id = $1 AND business_date = $2`,
        [operatorId, businessDate],
      )
    ).rows[0]!;

    const checksum = createHash('sha256')
      .update(JSON.stringify({ lines, held: held.map((h) => h.session_id) }))
      .digest('hex');

    const latest = (
      await c.query<{ version: number; checksum: string }>(
        `SELECT version, checksum FROM settlement_statements
          WHERE operator_id = $1 AND business_date = $2 ORDER BY version DESC LIMIT 1`,
        [operatorId, businessDate],
      )
    ).rows[0];

    const statement: Statement = {
      operatorId,
      businessDate,
      version: latest && latest.checksum === checksum ? latest.version : (latest?.version ?? 0) + 1,
      currency: op.currency,
      timezone: op.timezone,
      sessionCount: totals.n,
      energyWh: totals.energy,
      totalAmount: totals.total,
      heldCount: held.length,
      checksum,
    };
    if (latest && latest.checksum === checksum) return { status: 'unchanged', statement };

    await c.query(
      `INSERT INTO settlement_statements (operator_id, business_date, version, currency, timezone, session_count,
                                          energy_wh, total_amount, held_count, checksum)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        operatorId,
        businessDate,
        statement.version,
        statement.currency,
        statement.timezone,
        statement.sessionCount,
        statement.energyWh,
        statement.totalAmount,
        statement.heldCount,
        checksum,
      ],
    );
    return { status: 'created', statement };
  });
}
