-- Extensions: TimescaleDB for telemetry hypertables, PostGIS for site geography.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS postgis;

-- Two login roles. Passwords are set by the migration runner from the environment.
--   gridwatch_ingest: webhook receiver, poller, processor, settlement. Writes for
--                     every tenant, so it bypasses row-level security.
--   gridwatch_api:    the query API. Read-only and subject to row-level security.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gridwatch_ingest') THEN
    CREATE ROLE gridwatch_ingest LOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gridwatch_api') THEN
    CREATE ROLE gridwatch_api LOGIN NOBYPASSRLS;
  END IF;
END $$;
