-- The live simulator adds a steady stream of events from the generated sites.
-- Views over ingest_outcomes filter those out often, so the flag lives on the
-- row (set by the processor) rather than in a join on every query.
ALTER TABLE ingest_outcomes ADD COLUMN synthetic boolean NOT NULL DEFAULT false;
UPDATE ingest_outcomes o SET synthetic = true FROM sites s WHERE s.site_id = o.site_id AND s.synthetic;
CREATE INDEX ingest_outcomes_synthetic_idx ON ingest_outcomes (synthetic, outcome_id);

-- now() is the start of the processor's batch transaction; clock_timestamp()
-- is when the row was actually written, which is what latency should measure.
ALTER TABLE ingest_outcomes ALTER COLUMN processed_at SET DEFAULT clock_timestamp();
