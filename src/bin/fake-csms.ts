import path from 'node:path';
import { buildFakeCsms } from '../fake-csms/server.js';

const { app, runWebhookScript } = buildFakeCsms({
  fixturesDir: path.resolve(process.env.FIXTURES_DIR ?? 'fixtures/stubs'),
  seedDir: path.resolve(process.env.SEED_DIR ?? 'seed'),
  webhookUrl: process.env.WEBHOOK_URL ?? null,
  webhookSecret: process.env.WEBHOOK_HMAC_SECRET ?? 'dev-only-webhook-secret',
  errorRate: Number(process.env.FAKE_ERROR_RATE ?? 0),
  minIntervalSec: Number(process.env.FAKE_MIN_INTERVAL_SEC ?? 30),
  // A live network on the generated sites (see src/fake-csms/live.ts).
  live:
    (process.env.LIVE_SIM ?? 'off') === 'on'
      ? {
          seed: Number(process.env.LIVE_SEED ?? 1),
          duplicateRate: Number(process.env.LIVE_DUPLICATE_RATE ?? 0.05),
          malformedRate: Number(process.env.LIVE_MALFORMED_RATE ?? 0.02),
          lateRate: Number(process.env.LIVE_LATE_RATE ?? 0.01),
        }
      : null,
  logger: true,
});
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8090) });
void runWebhookScript().catch((err) => console.error('webhook script failed:', err));

for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
