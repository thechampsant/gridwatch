import type { Client } from '../db/pool.js';

// The one place a charge line is written. Money is computed in NUMERIC,
// rounded half-up to the currency's minor unit. The business day is the stop's
// local date in the site's IANA zone. A UNIQUE key on the session makes a
// second line impossible, whoever asks.
//
// The tariff in force at session start applies. A session the operator bills
// after review may have no start (only its stop arrived); then the tariff in
// force at the stop applies, and the review records that it did.

export type TariffBasis = 'session_start' | 'session_stop';

export async function insertCharge(
  c: Client,
  key: [connectionId: string, sessionId: string],
  o: { allowStopBasis: boolean },
): Promise<boolean> {
  const r = await c.query(
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
          WHERE operator_id = s.operator_id
            AND valid_from <= CASE WHEN $3 THEN coalesce(s.started_at, s.stopped_at) ELSE s.started_at END
            AND (valid_to IS NULL OR valid_to > CASE WHEN $3 THEN coalesce(s.started_at, s.stopped_at) ELSE s.started_at END)
          ORDER BY valid_from DESC LIMIT 1
       ) t ON true
      WHERE s.connection_id = $1 AND s.session_id = $2
     ON CONFLICT (connection_id, session_id) DO NOTHING`,
    [...key, o.allowStopBasis],
  );
  return (r.rowCount ?? 0) > 0;
}
