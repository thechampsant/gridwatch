import type { Client, TenantContext } from '../db/pool.js';
import { insertCharge, type TariffBasis } from './charge.js';
import { maxPlausibleWh } from './energy.js';

// The operator (CPO) resolves a session billing held for review: bill an
// amount it has confirmed (from the charger's own log, say), or void it.
// Runs as the API role, so row-level security decides whose sessions these
// are: another operator's session simply isn't there, and GridWatch staff
// (no operator) can't write at all.

export type ReviewDecision = { action: 'bill'; energyWh: number; note: string } | { action: 'void'; note: string };

export class ReviewError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

interface HeldRow {
  operator_id: string;
  started_at: Date | null;
  stopped_at: Date | null;
  billing_status: string;
  review_reason: string | null;
  max_kw: number;
  business_date: string | null;
}

export interface ReviewResult {
  operatorId: string;
  businessDate: string | null;
  billingStatus: 'charged' | 'voided';
  review: { reviewId: number; action: string; energyWh: number | null; tariffBasis: TariffBasis | null; note: string };
}

export async function reviewSession(
  c: Client,
  key: [connectionId: string, sessionId: string],
  decision: ReviewDecision,
  who: TenantContext,
  tolerance: number,
): Promise<ReviewResult> {
  const s = (
    await c.query<HeldRow>(
      `SELECT se.operator_id, se.started_at, se.stopped_at, se.billing_status, se.review_reason, ch.max_kw::float8 AS max_kw,
              (se.stopped_at AT TIME ZONE st.timezone)::date::text AS business_date
         FROM sessions se
         JOIN sites st ON st.site_id = se.site_id
         JOIN chargers ch ON ch.charger_id = se.charger_id
        WHERE se.connection_id = $1 AND se.session_id = $2
          FOR UPDATE OF se`,
      key,
    )
  ).rows[0];
  if (!s) throw new ReviewError(404, 'no such session on your network');
  if (s.billing_status !== 'needs_review') throw new ReviewError(409, `this session is ${s.billing_status.replace('_', ' ')}, not held for review`);

  let tariffBasis: TariffBasis | null = null;
  if (decision.action === 'bill') {
    if (!s.stopped_at) throw new ReviewError(400, 'the session has no end time, so it has no business day to bill on; void it or wait for the stop');
    if (s.started_at) {
      const limit = maxPlausibleWh(s.max_kw, s.stopped_at.getTime() - s.started_at.getTime(), tolerance);
      if (decision.energyWh > limit) {
        throw new ReviewError(400, `${(decision.energyWh / 1000).toFixed(3)} kWh is more than this charger can deliver in that time (at most ${(Math.floor(limit) / 1000).toFixed(3)} kWh)`);
      }
    }
    await c.query(
      `UPDATE sessions SET billing_status = 'charged', energy_wh = $3, energy_method = 'manual_review', updated_at = now()
        WHERE connection_id = $1 AND session_id = $2`,
      [...key, decision.energyWh],
    );
    tariffBasis = s.started_at ? 'session_start' : 'session_stop';
    if (!(await insertCharge(c, key, { allowStopBasis: true }))) {
      throw new ReviewError(409, 'no tariff is in force for this session, so it cannot be billed; void it or add a tariff');
    }
  } else {
    await c.query(`UPDATE sessions SET billing_status = 'voided', updated_at = now() WHERE connection_id = $1 AND session_id = $2`, key);
  }

  const energyWh = decision.action === 'bill' ? decision.energyWh : null;
  const review = (
    await c.query<{ review_id: number }>(
      `INSERT INTO session_reviews (connection_id, session_id, operator_id, action, energy_wh, tariff_basis, note,
                                    previous_status, previous_reason, reviewed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING review_id`,
      [...key, s.operator_id, decision.action, energyWh, tariffBasis, decision.note, s.billing_status, s.review_reason, who.subject],
    )
  ).rows[0]!;
  await c.query(`INSERT INTO audit_log (subject, role, action, detail) VALUES ($1, $2, $3, $4)`, [
    who.subject,
    who.role,
    'POST /v1/sessions/:connectionId/:sessionId/review',
    JSON.stringify({ connectionId: key[0], sessionId: key[1], action: decision.action, energyWh, note: decision.note }),
  ]);

  return {
    operatorId: s.operator_id,
    businessDate: s.business_date,
    billingStatus: decision.action === 'bill' ? 'charged' : 'voided',
    review: { reviewId: Number(review.review_id), action: decision.action, energyWh, tariffBasis, note: decision.note },
  };
}
