-- Tenant isolation in the database, not in application code.
-- The API sets app.operator_id / app.role per transaction from the verified
-- token (SET LOCAL via set_config). A forgotten WHERE clause can't leak rows.

CREATE FUNCTION app_operator() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.operator_id', true), '') $$;

CREATE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.role', true), '') = 'platform_admin' $$;

GRANT USAGE ON SCHEMA public TO gridwatch_api, gridwatch_ingest;

-- Ingestion writes everything (and bypasses RLS: see 001).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gridwatch_ingest;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gridwatch_ingest;

-- The API reads only what the dashboard needs, and no telemetry hypertables:
-- continuous aggregates cannot be built on tables with RLS, so the API never
-- touches raw telemetry directly.
GRANT SELECT ON operators, sites, chargers, connectors, tariffs, connector_state, poll_state,
                sessions, charges, settlement_statements, ingest_outcomes, csms_inbox,
                csms_calls, quarantine
  TO gridwatch_api;
GRANT INSERT ON audit_log TO gridwatch_api;
GRANT USAGE ON SEQUENCE audit_log_audit_id_seq TO gridwatch_api;

-- Tenant-owned tables: a row is visible to its operator, or to platform admins.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['operators', 'sites', 'chargers', 'connectors', 'tariffs', 'connector_state',
                           'poll_state', 'sessions', 'charges', 'settlement_statements', 'ingest_outcomes']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_read ON %I FOR SELECT USING (app_is_admin() OR operator_id = app_operator())', t);
  END LOOP;
END $$;

-- Platform-only tables: raw vendor payloads, call log, dead letters.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['csms_inbox', 'csms_calls', 'quarantine']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY admin_read ON %I FOR SELECT USING (app_is_admin())', t);
  END LOOP;
END $$;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_append ON audit_log FOR INSERT WITH CHECK (true);
