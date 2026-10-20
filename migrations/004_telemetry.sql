-- Live state: one row per connector. Small (about 100k rows at production
-- scale) and always hot. Every column is guarded by event time, so arrival
-- order never matters.
CREATE TABLE connector_state (
  charger_id            text NOT NULL,
  connector_id          text NOT NULL,
  operator_id           text NOT NULL,
  site_id               text NOT NULL,
  status                text,
  status_ts             timestamptz,
  status_received_at    timestamptz,
  power_w               integer,
  energy_wh             bigint,
  meter_ts              timestamptz,
  active_fault_code     text,
  active_fault_severity text,
  active_fault_ts       timestamptz,
  last_seen_at          timestamptz,  -- newest event time we hold for this connector
  last_seen_via         text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (charger_id, connector_id)
);
CREATE INDEX connector_state_site_idx ON connector_state (site_id);

-- Deterministic tie-break when two status events carry the same timestamp:
-- the more severe status wins, so the outcome never depends on arrival order.
CREATE FUNCTION status_rank(s text) RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE s
    WHEN 'Faulted'       THEN 90
    WHEN 'Unavailable'   THEN 80
    WHEN 'Charging'      THEN 70
    WHEN 'SuspendedEV'   THEN 60
    WHEN 'SuspendedEVSE' THEN 55
    WHEN 'Occupied'      THEN 50
    WHEN 'Finishing'     THEN 40
    WHEN 'Preparing'     THEN 30
    WHEN 'Reserved'      THEN 20
    WHEN 'Available'     THEN 10
    ELSE 0
  END
$$;

-- Telemetry hypertables. Natural keys include time, which makes every insert
-- idempotent (ON CONFLICT DO NOTHING) under at-least-once delivery.
-- Production would use integer surrogate keys for charger/connector to halve
-- row size; text keeps the slice readable.
CREATE TABLE meter_readings (
  ts           timestamptz NOT NULL,
  charger_id   text NOT NULL,
  connector_id text NOT NULL,
  operator_id  text NOT NULL,
  energy_wh    bigint NOT NULL CHECK (energy_wh >= 0),  -- lifetime register, not per-session
  power_w      integer,
  received_at  timestamptz NOT NULL,
  PRIMARY KEY (charger_id, connector_id, ts)
);
SELECT create_hypertable('meter_readings', by_range('ts', INTERVAL '1 day'));

CREATE TABLE status_events (
  ts           timestamptz NOT NULL,
  charger_id   text NOT NULL,
  connector_id text NOT NULL,
  operator_id  text NOT NULL,
  status       text NOT NULL,
  received_at  timestamptz NOT NULL,
  PRIMARY KEY (charger_id, connector_id, ts, status)
);
SELECT create_hypertable('status_events', by_range('ts', INTERVAL '7 days'));

CREATE TABLE fault_events (
  ts           timestamptz NOT NULL,
  charger_id   text NOT NULL,
  connector_id text NOT NULL,
  operator_id  text NOT NULL,
  code         text NOT NULL,
  severity     text NOT NULL,
  received_at  timestamptz NOT NULL,
  PRIMARY KEY (charger_id, connector_id, ts, code)
);
SELECT create_hypertable('fault_events', by_range('ts', INTERVAL '30 days'));

-- Compression only once data is past the lateness window (vendor batches and
-- redeliveries arrive within hours, so 7 days is generous). Raw meter readings
-- are kept 90 days; rollups would be kept for years.
ALTER TABLE meter_readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'charger_id, connector_id',
  timescaledb.compress_orderby = 'ts DESC'
);
SELECT add_compression_policy('meter_readings', compress_after => INTERVAL '7 days',
                              initial_start => now() + INTERVAL '1 day');
SELECT add_retention_policy('meter_readings', drop_after => INTERVAL '90 days',
                            initial_start => now() + INTERVAL '1 day');
SELECT add_retention_policy('status_events', drop_after => INTERVAL '400 days',
                            initial_start => now() + INTERVAL '1 day');
