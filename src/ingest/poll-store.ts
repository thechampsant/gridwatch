import type { Pool } from '../db/pool.js';
import type { PollPage } from '../csms/schemas.js';

// What the poller needs from storage. Postgres in production; an in-memory
// version drives the unit tests.
export interface SiteLease {
  siteId: string;
  operatorId: string;
  connectionId: string;
  highWaterMark: Date | null;
  savedCursor: string | null;
  savedSince: Date | null;
  consecutiveFailures: number;
  lastReconciledAt: Date | null;
}

export interface CallRecord {
  siteId: string;
  request: string;
  statusCode: number | null;
  outcome: string;
  handling: string;
  startedAt: Date;
  durationMs: number;
}

export interface PollStore {
  claimDue(owner: string, limit: number, leaseSec: number, minIntervalSec: number): Promise<SiteLease[]>;
  markRequest(siteId: string, at: Date): Promise<void>;
  // Durable before the poller moves on: the page is in the inbox.
  storePage(site: SiteLease, page: PollPage, raw: unknown, deliveryRef: string, serverTime: Date): Promise<void>;
  storeInvalidPage(site: SiteLease, body: string, reason: string): Promise<void>;
  recordCall(call: CallRecord): Promise<void>;
  hasActiveSession(siteId: string): Promise<boolean>;
  completeCycle(siteId: string, hwm: Date, contactAt: Date, nextPollAt: Date, reconciled: boolean): Promise<void>;
  rateLimited(siteId: string, cursor: string | null, since: Date | null, nextPollAt: Date): Promise<void>;
  failCycle(siteId: string, outcome: string, nextPollAt: Date): Promise<void>;
}

export class PgPollStore implements PollStore {
  constructor(private readonly pool: Pool) {}

  async claimDue(owner: string, limit: number, leaseSec: number, minIntervalSec: number): Promise<SiteLease[]> {
    const r = await this.pool.query(
      `UPDATE poll_state p SET lease_owner = $1, lease_until = now() + make_interval(secs => $3)
        WHERE p.site_id IN (
          SELECT site_id FROM poll_state
           WHERE next_poll_at <= now()
             AND (lease_until IS NULL OR lease_until < now())
             AND (last_request_at IS NULL OR last_request_at <= now() - make_interval(secs => $4))
           ORDER BY next_poll_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING site_id, operator_id, connection_id, high_water_mark, saved_cursor, saved_since,
                  consecutive_failures, last_reconciled_at`,
      [owner, limit, leaseSec, minIntervalSec],
    );
    return r.rows.map((x) => ({
      siteId: x.site_id,
      operatorId: x.operator_id,
      connectionId: x.connection_id,
      highWaterMark: x.high_water_mark,
      savedCursor: x.saved_cursor,
      savedSince: x.saved_since,
      consecutiveFailures: x.consecutive_failures,
      lastReconciledAt: x.last_reconciled_at,
    }));
  }

  async markRequest(siteId: string, at: Date): Promise<void> {
    await this.pool.query(`UPDATE poll_state SET last_request_at = $2 WHERE site_id = $1`, [siteId, at]);
  }

  async storePage(site: SiteLease, page: PollPage, raw: unknown, deliveryRef: string, serverTime: Date) {
    await this.pool.query(
      `WITH ins AS (
         INSERT INTO csms_inbox (connection_id, source, delivery_ref, site_id, server_time, payload)
         VALUES ($1, 'poll', $2, $3, $4, $5) RETURNING inbox_id)
       SELECT pg_notify('csms_inbox', inbox_id::text) FROM ins`,
      [site.connectionId, deliveryRef, page.site_id, serverTime, JSON.stringify(raw)],
    );
  }

  async storeInvalidPage(site: SiteLease, body: string, reason: string) {
    await this.pool.query(
      `INSERT INTO quarantine (connection_id, operator_id, raw_text, reason, detail)
       VALUES ($1, $2, $3, 'invalid_page', $4)`,
      [site.connectionId, site.operatorId, body.slice(0, 100_000), `${site.siteId}: ${reason}`],
    );
  }

  async recordCall(call: CallRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO csms_calls (direction, connection_id, site_id, request, status_code, outcome, handling, started_at, duration_ms)
       SELECT 'poll', connection_id, $1, $2, $3, $4, $5, $6, $7 FROM poll_state WHERE site_id = $1`,
      [call.siteId, call.request, call.statusCode, call.outcome, call.handling, call.startedAt, call.durationMs],
    );
  }

  async hasActiveSession(siteId: string): Promise<boolean> {
    const r = await this.pool.query<{ active: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM connector_state
                       WHERE site_id = $1
                         AND status IN ('Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing', 'Occupied'))
           OR EXISTS (SELECT 1 FROM sessions WHERE site_id = $1 AND billing_status = 'open') AS active`,
      [siteId],
    );
    return r.rows[0]?.active ?? false;
  }

  async completeCycle(siteId: string, hwm: Date, contactAt: Date, nextPollAt: Date, reconciled: boolean) {
    await this.pool.query(
      `UPDATE poll_state SET
         high_water_mark = GREATEST(high_water_mark, $2),
         last_contact_at = GREATEST(last_contact_at, $3),
         saved_cursor = NULL, saved_since = NULL,
         consecutive_failures = 0, last_outcome = 'ok', next_poll_at = $4,
         last_reconciled_at = CASE WHEN $5 THEN now() ELSE last_reconciled_at END,
         lease_owner = NULL, lease_until = NULL
       WHERE site_id = $1`,
      [siteId, hwm, contactAt, nextPollAt, reconciled],
    );
  }

  async rateLimited(siteId: string, cursor: string | null, since: Date | null, nextPollAt: Date) {
    await this.pool.query(
      `UPDATE poll_state SET saved_cursor = $2, saved_since = $3, next_poll_at = $4, last_outcome = 'rate_limited',
              lease_owner = NULL, lease_until = NULL
        WHERE site_id = $1`,
      [siteId, cursor, since, nextPollAt],
    );
  }

  async failCycle(siteId: string, outcome: string, nextPollAt: Date) {
    await this.pool.query(
      `UPDATE poll_state SET consecutive_failures = consecutive_failures + 1, saved_cursor = NULL, saved_since = NULL,
              last_outcome = $2, next_poll_at = $3, lease_owner = NULL, lease_until = NULL
        WHERE site_id = $1`,
      [siteId, outcome, nextPollAt],
    );
  }
}
