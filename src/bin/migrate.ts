import path from 'node:path';
import { config } from '../config.js';
import { createPool, withTx } from '../db/pool.js';
import { pauseTelemetryPolicies, runMigrations, setRolePasswords } from '../db/migrate.js';
import { CacheStep, geocodePendingSites, OverrideStep, PostalGazetteerStep } from '../geo/geocoder.js';
import { loadCatalog, loadGazetteer } from '../seed/catalog.js';

// One-shot: schema, role passwords, (with --seed) pilot catalogue + geocoding.
const adminUrl = config.adminDatabaseUrl();
await runMigrations(adminUrl, path.resolve('migrations'));
await setRolePasswords(adminUrl, {
  gridwatch_ingest: process.env.INGEST_DB_PASSWORD ?? 'gridwatch_ingest',
  gridwatch_api: process.env.API_DB_PASSWORD ?? 'gridwatch_api',
});
if (config.demoMode()) {
  const paused = await pauseTelemetryPolicies(adminUrl);
  console.log(`demo mode: paused ${paused} retention/compression job(s) (stub data is dated June 2026)`);
}

if (process.argv.includes('--seed')) {
  const pool = createPool(adminUrl, 2);
  const seedDir = path.resolve('seed');
  const gazetteer = await loadGazetteer(seedDir);
  await withTx(pool, async (c) => {
    const loaded = await loadCatalog(c, {
      seedDir,
      connectionId: config.csmsConnectionId(),
      csmsBaseUrl: config.csmsBaseUrl(),
      includeSynthetic: true,
    });
    console.log(`catalogue: ${loaded.sites} sites, ${loaded.chargers} chargers`);
    const geo = await geocodePendingSites(c, [new OverrideStep(c), new CacheStep(c), new PostalGazetteerStep(gazetteer)]);
    console.log(`geocoding: ${geo.resolved} resolved, unresolved: ${geo.unresolved.join(', ') || 'none'}`);
  });
  await pool.end();
}
console.log('migrate done');
