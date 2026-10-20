import pg from 'pg';
import { archiveProcessed } from '../archive/archiver.js';
import { s3Client } from '../archive/aws.js';
import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { processPending, refreshBacklogGauge, sweepSessions, type ProcessorOptions } from '../ingest/processor.js';
import { startMetricsServer } from '../observability/metrics.js';

// Drains the inbox. Woken by NOTIFY from the webhook receiver and poller for
// low latency, with a 1 s fallback tick in case a notification is missed.
// Any number of processors can run: rows are claimed with SKIP LOCKED.
const pool = createPool(config.databaseUrl());
const opts: ProcessorOptions = {
  batchSize: 50,
  maxAttempts: 5,
  futureSkewSec: config.futureSkewSec(),
  energy: { tolerance: config.plausibilityTolerance(), resetMaxGapSec: config.resetMaxGapSec() },
};
const bucket = config.rawArchiveBucket();
const s3 = bucket ? s3Client() : null;
startMetricsServer(config.metricsPort());

let wake: (() => void) | null = null;
const listener = new pg.Client({ connectionString: config.databaseUrl() });
await listener.connect();
await listener.query('LISTEN csms_inbox');
listener.on('notification', () => wake?.());

let running = true;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => (running = false));

let lastHousekeeping = 0;
console.log('processor started');
while (running) {
  try {
    let n: number;
    do {
      n = await processPending(pool, opts);
    } while (n > 0 && running);

    if (Date.now() - lastHousekeeping > 5_000) {
      lastHousekeeping = Date.now();
      await refreshBacklogGauge(pool);
      const swept = await sweepSessions(pool, config.sessionGraceSec());
      if (swept) console.log(`moved ${swept} incomplete session(s) to review`);
      if (s3 && bucket) await archiveProcessed(pool, s3, bucket);
    }
  } catch (err) {
    console.error('processor loop error:', (err as Error).message);
  }
  await new Promise<void>((resolve) => {
    wake = resolve;
    setTimeout(resolve, 1_000);
  });
  wake = null;
}
await listener.end();
await pool.end();
process.exit(0);
