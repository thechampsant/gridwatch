import path from 'node:path';
import { SecretsManagerProvider, StaticSecretProvider } from '../archive/aws.js';
import { buildServer } from '../api/server.js';
import { ChangeHub } from '../api/stream.js';
import { systemClock } from '../clock.js';
import { config } from '../config.js';
import { createPool } from '../db/pool.js';

const fallback = config.webhookSecretFallback();
// Listens for committed changes and pushes them to open dashboards.
const changes = new ChangeHub(config.apiDatabaseUrl(), (m) => console.warn(m));
await changes.start();
const app = await buildServer({
  ingestPool: createPool(config.databaseUrl()),
  apiPool: createPool(config.apiDatabaseUrl()),
  secrets: fallback ? new StaticSecretProvider([fallback]) : new SecretsManagerProvider(),
  clock: systemClock,
  jwtSecret: config.jwtSecret(),
  demoMode: config.demoMode(),
  demoNow: config.demoNow(),
  staleAfterSec: config.staleAfterSec(),
  billing: { tolerance: config.plausibilityTolerance(), graceSec: Number(process.env.SETTLEMENT_GRACE_SEC ?? 7200) },
  publicDir: path.resolve('public'),
  logger: true,
  changes,
});

await app.listen({ host: '0.0.0.0', port: config.port() });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void app
      .close()
      .then(() => changes.stop())
      .then(() => process.exit(0));
  });
}
