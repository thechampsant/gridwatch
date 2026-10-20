-- Sessions are merged from start/stop events in any order. Keyed by
-- connection + vendor session_id: two vendors could reuse the same IDs.
CREATE TABLE sessions (
  connection_id  text NOT NULL,
  session_id     text NOT NULL,
  operator_id    text NOT NULL,
  site_id        text NOT NULL,
  charger_id     text NOT NULL,
  connector_id   text NOT NULL,
  started_at     timestamptz,
  stopped_at     timestamptz,
  start_meter_wh bigint,
  stop_meter_wh  bigint,
  energy_wh      bigint CHECK (energy_wh IS NULL OR energy_wh >= 0),
  energy_method  text,  -- register_delta | reset_reconstructed
  billing_status text NOT NULL DEFAULT 'open'
                 CHECK (billing_status IN ('open', 'awaiting_start', 'charged', 'needs_review')),
  review_reason  text,
  review_detail  text,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, session_id)
);
CREATE INDEX sessions_operator_idx ON sessions (operator_id, stopped_at);

-- One charge per session, enforced by the database: a redelivered
-- session.stop can never produce a second invoice line.
CREATE TABLE charges (
  charge_id     bigserial PRIMARY KEY,
  connection_id text NOT NULL,
  session_id    text NOT NULL,
  operator_id   text NOT NULL,
  site_id       text NOT NULL,
  business_date date NOT NULL,  -- local date of the stop, in the site's IANA zone
  timezone      text NOT NULL,
  currency      char(3) NOT NULL,
  energy_wh     bigint NOT NULL CHECK (energy_wh >= 0),
  tariff_id     text NOT NULL REFERENCES tariffs,
  price_per_kwh numeric(12, 4) NOT NULL,
  session_fee   numeric(12, 2) NOT NULL,
  energy_amount numeric(14, 2) NOT NULL,
  total_amount  numeric(14, 2) NOT NULL CHECK (total_amount >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, session_id),
  FOREIGN KEY (connection_id, session_id) REFERENCES sessions
);
CREATE INDEX charges_settlement_idx ON charges (operator_id, business_date);

-- Daily statements are versioned, never edited: if late data changes a day
-- that was already settled, a new version is issued and the old one kept.
CREATE TABLE settlement_statements (
  operator_id   text NOT NULL,
  business_date date NOT NULL,
  version       int  NOT NULL,
  currency      char(3) NOT NULL,
  timezone      text NOT NULL,
  session_count int NOT NULL,
  energy_wh     bigint NOT NULL,
  total_amount  numeric(14, 2) NOT NULL,
  held_count    int NOT NULL,
  checksum      text NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, business_date, version)
);

-- Cross-tenant reads by GridWatch staff are recorded here.
CREATE TABLE audit_log (
  audit_id bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  subject  text NOT NULL,
  role     text NOT NULL,
  action   text NOT NULL,
  detail   jsonb
);
