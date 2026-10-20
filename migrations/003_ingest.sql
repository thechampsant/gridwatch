-- Ingestion: a durable inbox. The webhook receiver and the poller only append
-- raw vendor payloads here (acknowledge after a durable write); the processor
-- claims rows with SKIP LOCKED and applies them. In production this role is
-- played by a Kafka topic; the apply logic is the same.

CREATE TABLE csms_inbox (
  inbox_id      bigserial PRIMARY KEY,
  connection_id text NOT NULL REFERENCES csms_connections,
  source        text NOT NULL CHECK (source IN ('webhook', 'poll')),
  delivery_ref  text,         -- webhook delivery_id, or poll "site#cycle:page"
  site_id       text,         -- poll only: the site that was polled
  server_time   timestamptz,  -- poll only: vendor clock when the page was served
  received_at   timestamptz NOT NULL DEFAULT now(),
  payload       jsonb NOT NULL,
  processed_at  timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  last_error    text,
  archived_at   timestamptz
);
CREATE INDEX csms_inbox_pending_idx ON csms_inbox (inbox_id) WHERE processed_at IS NULL;
CREATE INDEX csms_inbox_unarchived_idx ON csms_inbox (inbox_id)
  WHERE archived_at IS NULL AND processed_at IS NOT NULL;

-- Dead-letter store: one row per rejected event (or whole payload).
CREATE TABLE quarantine (
  quarantine_id bigserial PRIMARY KEY,
  inbox_id      bigint REFERENCES csms_inbox,
  event_index   int,
  connection_id text,
  operator_id   text,  -- null when the event cannot be attributed to a tenant
  payload       jsonb,
  raw_text      text,  -- for bodies that are not even JSON
  reason        text NOT NULL,
  detail        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inbox_id, event_index)
);

-- Poll scheduling and cursor state, one row per site. Workers claim due rows
-- with a lease (SKIP LOCKED), so any number of pollers can run.
CREATE TABLE poll_state (
  site_id              text PRIMARY KEY REFERENCES sites,
  operator_id          text NOT NULL,
  connection_id        text NOT NULL,
  high_water_mark      timestamptz,  -- vendor server_time of the last completed cycle
  saved_cursor         text,         -- resume point after a 429 mid-pagination
  saved_since          timestamptz,
  next_poll_at         timestamptz NOT NULL DEFAULT now(),
  last_request_at      timestamptz,
  lease_owner          text,
  lease_until          timestamptz,
  consecutive_failures int NOT NULL DEFAULT 0,
  last_outcome         text,
  last_contact_at      timestamptz,  -- vendor server_time of the last good page
  last_reconciled_at   timestamptz
);
CREATE INDEX poll_state_due_idx ON poll_state (next_poll_at);

-- Every vendor exchange, both directions. Backs the admin "vendor calls" view.
CREATE TABLE csms_calls (
  call_id       bigserial PRIMARY KEY,
  direction     text NOT NULL CHECK (direction IN ('poll', 'webhook')),
  connection_id text NOT NULL,
  site_id       text,
  request       text NOT NULL,
  status_code   int,  -- null on timeout / network error
  outcome       text NOT NULL,
  handling      text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  duration_ms   int
);

-- What the pipeline did with each event and why. Backs the ingestion log.
-- At production volume this becomes counters plus sampled rows.
CREATE TABLE ingest_outcomes (
  outcome_id     bigserial PRIMARY KEY,
  inbox_id       bigint NOT NULL REFERENCES csms_inbox,
  event_index    int NOT NULL,
  operator_id    text,
  site_id        text,
  source         text NOT NULL,
  delivery_ref   text,
  event_type     text NOT NULL,
  summary        text NOT NULL,
  charger_id     text,
  connector_id   text,
  event_ts_local text,
  event_ts       timestamptz,
  outcome        text NOT NULL CHECK (outcome IN ('applied', 'stale', 'duplicate', 'quarantined', 'held')),
  reason         text NOT NULL,
  received_at    timestamptz NOT NULL,
  server_time    timestamptz,
  processed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inbox_id, event_index)
);
CREATE INDEX ingest_outcomes_operator_idx ON ingest_outcomes (operator_id, outcome_id);
