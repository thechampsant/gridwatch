// All runtime configuration comes from the environment. Defaults are for local
// development only; docker-compose.yml sets every value explicitly.

function str(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required env var ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env var ${name} must be a number, got ${raw}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export const config = {
  // Ingestion components connect as gridwatch_ingest (BYPASSRLS: it writes for every tenant).
  databaseUrl: () => str('DATABASE_URL', 'postgres://gridwatch_ingest:gridwatch_ingest@localhost:55432/gridwatch'),
  // Query API connects as gridwatch_api (no BYPASSRLS, so row-level security applies).
  apiDatabaseUrl: () => str('API_DATABASE_URL', 'postgres://gridwatch_api:gridwatch_api@localhost:55432/gridwatch'),
  // Migrations run as the database owner.
  adminDatabaseUrl: () => str('DATABASE_ADMIN_URL', 'postgres://postgres:gridwatch@localhost:55432/gridwatch'),

  port: () => num('PORT', 8080),
  metricsPort: () => num('METRICS_PORT', 9100),

  jwtSecret: () => str('JWT_SECRET', 'dev-only-jwt-secret-change-me'),
  demoMode: () => bool('DEMO_MODE', false),
  // Fixed "now" for queries that judge freshness. Unset = wall clock.
  demoNow: () => process.env.DEMO_NOW || undefined,

  csmsBaseUrl: () => str('CSMS_BASE_URL', 'http://localhost:8090'),
  csmsConnectionId: () => str('CSMS_CONNECTION_ID', 'csms-main'),
  csmsRequestTimeoutMs: () => num('CSMS_REQUEST_TIMEOUT_MS', 10_000),

  awsEndpoint: () => process.env.AWS_ENDPOINT_URL || undefined,
  awsRegion: () => str('AWS_REGION', 'us-east-1'),
  rawArchiveBucket: () => process.env.RAW_ARCHIVE_BUCKET || undefined,
  // Only for tests and local runs without Secrets Manager.
  webhookSecretFallback: () => process.env.WEBHOOK_HMAC_SECRET_FALLBACK || undefined,

  poll: {
    minIntervalSec: () => num('POLL_MIN_INTERVAL_SEC', 30),
    activeIntervalSec: () => num('POLL_ACTIVE_INTERVAL_SEC', 30),
    idleIntervalSec: () => num('POLL_IDLE_INTERVAL_SEC', 120),
    overlapSec: () => num('POLL_OVERLAP_SEC', 300),
    initialLookbackSec: () => num('POLL_INITIAL_LOOKBACK_SEC', 86_400),
    reconcileEverySec: () => num('POLL_RECONCILE_EVERY_SEC', 3_600),
    reconcileWindowSec: () => num('POLL_RECONCILE_WINDOW_SEC', 7_200),
    maxConcurrency: () => num('POLL_MAX_CONCURRENCY', 8),
    maxAttempts: () => num('POLL_MAX_ATTEMPTS', 3),
    backoffBaseMs: () => num('POLL_BACKOFF_BASE_MS', 500),
    backoffCapMs: () => num('POLL_BACKOFF_CAP_MS', 4_000),
  },

  // A site not heard from (poll or event) within this window is stale and
  // excluded from nearest-available.
  staleAfterSec: () => num('STALE_AFTER_SEC', 300),
  // Session energy may not exceed max_kw x duration x this factor.
  plausibilityTolerance: () => num('PLAUSIBILITY_TOLERANCE', 1.1),
  // A meter reset is only reconstructed when readings bracket it this closely.
  resetMaxGapSec: () => num('RESET_MAX_GAP_SEC', 120),
  // Sessions missing a start (or stop) are swept to review after this long.
  sessionGraceSec: () => num('SESSION_GRACE_SEC', 7_200),
  // Events stamped later than vendor time (or receipt) + this are rejected.
  futureSkewSec: () => num('FUTURE_SKEW_SEC', 300),
};
