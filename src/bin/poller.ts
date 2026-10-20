import { randomUUID } from 'node:crypto';
import { systemClock } from '../clock.js';
import { config } from '../config.js';
import { CsmsClient } from '../csms/client.js';
import { createPool } from '../db/pool.js';
import { PgPollStore } from '../ingest/poll-store.js';
import { CircuitBreaker, pollSite, type PollerDeps } from '../ingest/poller.js';
import { startMetricsServer } from '../observability/metrics.js';

// Claims due sites with a lease and polls them with bounded concurrency.
// Several pollers can run side by side; leases keep them off each other's sites.
const pool = createPool(config.databaseUrl());
const store = new PgPollStore(pool);
const owner = `poller-${randomUUID().slice(0, 8)}`;
const deps: PollerDeps = {
  client: new CsmsClient(config.csmsBaseUrl(), undefined, config.csmsRequestTimeoutMs()),
  store,
  clock: systemClock,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
  opts: {
    minIntervalSec: config.poll.minIntervalSec(),
    activeIntervalSec: config.poll.activeIntervalSec(),
    idleIntervalSec: config.poll.idleIntervalSec(),
    overlapSec: config.poll.overlapSec(),
    initialLookbackSec: config.poll.initialLookbackSec(),
    reconcileEverySec: config.poll.reconcileEverySec(),
    reconcileWindowSec: config.poll.reconcileWindowSec(),
    maxAttempts: config.poll.maxAttempts(),
    backoffBaseMs: config.poll.backoffBaseMs(),
    backoffCapMs: config.poll.backoffCapMs(),
  },
};
const maxConcurrency = config.poll.maxConcurrency();
const breaker = new CircuitBreaker();
const inflight = new Set<Promise<void>>();
startMetricsServer(config.metricsPort());

let running = true;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => (running = false));

console.log(`${owner} started (max ${maxConcurrency} concurrent sites)`);
while (running) {
  try {
    const free = maxConcurrency - inflight.size;
    if (free > 0 && !breaker.isOpen()) {
      const due = await store.claimDue(owner, free, 120, deps.opts.minIntervalSec);
      for (const site of due) {
        const p: Promise<void> = pollSite(deps, site)
          .then((r) => {
            breaker.record(r.result !== 'failed');
            if (r.result !== 'ok') console.log(`${site.siteId}: ${r.result}${'reason' in r ? ` (${r.reason})` : ''}`);
          })
          .catch((err) => {
            breaker.record(false);
            console.error(`${site.siteId}: poll crashed: ${(err as Error).message}`);
          })
          .finally(() => inflight.delete(p));
        inflight.add(p);
      }
    }
  } catch (err) {
    console.error('poller loop error:', (err as Error).message);
  }
  await new Promise((r) => setTimeout(r, 500));
}
await Promise.allSettled(inflight);
await pool.end();
process.exit(0);
