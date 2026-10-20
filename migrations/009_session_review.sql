-- The exceptions queue (Part A §13): the operator (CPO) resolves a session
-- that billing held for review, by billing a confirmed amount or voiding it.
-- Every decision is kept; the daily statement is then re-issued.

ALTER TABLE sessions DROP CONSTRAINT sessions_billing_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_billing_status_check
  CHECK (billing_status IN ('open', 'awaiting_start', 'charged', 'needs_review', 'voided'));
-- energy_method also takes 'manual_review' for an amount the operator confirmed.

CREATE INDEX sessions_needs_review_idx ON sessions (operator_id) WHERE billing_status = 'needs_review';

-- Append-only: no role is granted UPDATE or DELETE.
CREATE TABLE session_reviews (
  review_id       bigserial PRIMARY KEY,
  connection_id   text NOT NULL,
  session_id      text NOT NULL,
  operator_id     text NOT NULL,
  action          text NOT NULL CHECK (action IN ('bill', 'void')),
  energy_wh       bigint CHECK (energy_wh IS NULL OR energy_wh > 0),
  tariff_basis    text CHECK (tariff_basis IN ('session_start', 'session_stop')),
  note            text NOT NULL CHECK (length(note) BETWEEN 5 AND 500),
  previous_status text NOT NULL,
  previous_reason text,
  reviewed_by     text NOT NULL,
  reviewed_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, session_id) REFERENCES sessions,
  CHECK ((action = 'bill') = (energy_wh IS NOT NULL))
);
CREATE INDEX session_reviews_session_idx ON session_reviews (connection_id, session_id, review_id);

ALTER TABLE settlement_statements ADD COLUMN voided_count int NOT NULL DEFAULT 0;

-- 006 granted the ingest role every table that existed then; new ones are explicit.
GRANT SELECT, INSERT ON session_reviews TO gridwatch_ingest, gridwatch_api;
GRANT USAGE ON SEQUENCE session_reviews_review_id_seq TO gridwatch_ingest, gridwatch_api;

-- The API role stays read-only except for this one workflow, and only on the
-- columns it needs. Row-level security decides whose rows: the operator's own.
GRANT UPDATE (billing_status, energy_wh, energy_method, updated_at) ON sessions TO gridwatch_api;
GRANT INSERT ON charges TO gridwatch_api;
GRANT USAGE ON SEQUENCE charges_charge_id_seq TO gridwatch_api;

CREATE POLICY operator_review ON sessions FOR UPDATE
  USING (operator_id = app_operator()) WITH CHECK (operator_id = app_operator());
CREATE POLICY operator_review ON charges FOR INSERT WITH CHECK (operator_id = app_operator());

ALTER TABLE session_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON session_reviews FOR SELECT USING (app_is_admin() OR operator_id = app_operator());
CREATE POLICY operator_review ON session_reviews FOR INSERT WITH CHECK (operator_id = app_operator());
