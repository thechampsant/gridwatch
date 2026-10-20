import path from 'node:path';
import { pauseTelemetryPolicies, runMigrations, setRolePasswords } from '../../src/db/migrate.js';
import { repoRoot } from '../helpers/fixtures.js';
import { serverClient, TEST_DB, urls } from './db.js';

// Fresh database per test run, migrated exactly as in production.
export default async function setup(): Promise<void> {
  const c = await serverClient().catch((err) => {
    throw new Error(
      `integration tests need Postgres (TimescaleDB + PostGIS): start it with "docker compose up -d db" ` +
        `or run "docker compose --profile test run --rm test". (${(err as Error).message})`,
    );
  });
  try {
    await c.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await c.end();
  }
  await runMigrations(urls.admin, path.join(repoRoot, 'migrations'), () => undefined);
  await setRolePasswords(urls.admin, { gridwatch_ingest: 'gridwatch_ingest', gridwatch_api: 'gridwatch_api' });
  await pauseTelemetryPolicies(urls.admin);
}
