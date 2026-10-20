import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Client } from '../db/pool.js';
import { normalizeAddress, type GazetteerEntry } from '../geo/geocoder.js';

// Loads the pilot catalogue (operators, sites, chargers, connectors), sample
// tariffs and geocoding seed. Idempotent: safe to run on every start.

interface PilotSite {
  site_id: string;
  operator_id: string;
  name: string;
  address: string;
  country: string;
}
interface PilotCharger {
  charger_id: string;
  site_id: string;
  model: string;
  max_kw: number;
  connectors: string[];
}

const COUNTRY = {
  IN: { currency: 'INR', timezone: 'Asia/Kolkata' },
  DE: { currency: 'EUR', timezone: 'Europe/Berlin' },
} as const;

async function readJson<T>(dir: string, file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(dir, file), 'utf8')) as T;
}

export interface CatalogOptions {
  seedDir: string;
  connectionId: string;
  csmsBaseUrl: string;
  includeSynthetic: boolean;
}

export async function loadCatalog(c: Client, o: CatalogOptions): Promise<{ sites: number; chargers: number }> {
  const pilot = await readJson<{
    operators: { operator_id: string; name: string; country: 'IN' | 'DE' }[];
    sites: PilotSite[];
    chargers: PilotCharger[];
  }>(o.seedDir, 'pilot-sample-data.json');
  const synthetic = o.includeSynthetic
    ? await readJson<{ sites: PilotSite[]; chargers: PilotCharger[] }>(o.seedDir, 'synthetic-pilot.json')
    : { sites: [], chargers: [] };

  for (const op of pilot.operators) {
    const meta = COUNTRY[op.country];
    await c.query(
      `INSERT INTO operators (operator_id, name, country, currency, timezone) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (operator_id) DO NOTHING`,
      [op.operator_id, op.name, op.country, meta.currency, meta.timezone],
    );
  }

  await c.query(
    `INSERT INTO csms_connections (connection_id, vendor, base_url, webhook_secret_ref)
     VALUES ($1, 'vendor-csms', $2, $3) ON CONFLICT (connection_id) DO UPDATE SET base_url = EXCLUDED.base_url`,
    [o.connectionId, o.csmsBaseUrl, `gridwatch/${o.connectionId}/webhook-hmac`],
  );

  const tz = new Map(pilot.operators.map((op) => [op.operator_id, COUNTRY[op.country].timezone]));
  const allSites = [
    ...pilot.sites.map((s) => ({ ...s, synthetic: false })),
    ...synthetic.sites.map((s) => ({ ...s, synthetic: true })),
  ];
  for (const s of allSites) {
    await c.query(
      `INSERT INTO sites (site_id, operator_id, connection_id, name, address, country, timezone, synthetic)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (site_id) DO NOTHING`,
      [s.site_id, s.operator_id, o.connectionId, s.name, s.address, s.country, tz.get(s.operator_id), s.synthetic],
    );
    await c.query(
      `INSERT INTO poll_state (site_id, operator_id, connection_id) VALUES ($1, $2, $3) ON CONFLICT (site_id) DO NOTHING`,
      [s.site_id, s.operator_id, o.connectionId],
    );
  }

  const siteOperator = new Map(allSites.map((s) => [s.site_id, s.operator_id]));
  const allChargers = [...pilot.chargers, ...synthetic.chargers];
  for (const ch of allChargers) {
    const operatorId = siteOperator.get(ch.site_id);
    if (!operatorId) throw new Error(`charger ${ch.charger_id} references unknown site ${ch.site_id}`);
    await c.query(
      `INSERT INTO chargers (charger_id, site_id, operator_id, connection_id, model, max_kw)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (charger_id) DO NOTHING`,
      [ch.charger_id, ch.site_id, operatorId, o.connectionId, ch.model, ch.max_kw],
    );
    for (const conn of ch.connectors) {
      await c.query(
        `INSERT INTO connectors (charger_id, connector_id, operator_id, site_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [ch.charger_id, conn, operatorId, ch.site_id],
      );
    }
  }

  const { tariffs } = await readJson<{
    tariffs: { tariff_id: string; operator_id: string; currency: string; price_per_kwh: string; session_fee: string; valid_from: string }[];
  }>(o.seedDir, 'tariffs.json');
  for (const t of tariffs) {
    await c.query(
      `INSERT INTO tariffs (tariff_id, operator_id, currency, price_per_kwh, session_fee, valid_from, is_sample)
       VALUES ($1, $2, $3, $4, $5, $6, true) ON CONFLICT (tariff_id) DO NOTHING`,
      [t.tariff_id, t.operator_id, t.currency, t.price_per_kwh, t.session_fee, t.valid_from],
    );
  }

  const geo = await readJson<{
    overrides: { site_id: string; lat: number; lng: number; precision: string; note: string; created_by: string }[];
    cache: { address: string; lat: number; lng: number; precision: string; source: string; confidence: number }[];
  }>(o.seedDir, 'geocode-seed.json');
  for (const g of geo.overrides) {
    await c.query(
      `INSERT INTO geocode_overrides (site_id, lat, lng, precision, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (site_id) DO NOTHING`,
      [g.site_id, g.lat, g.lng, g.precision, g.note, g.created_by],
    );
  }
  for (const g of geo.cache) {
    await c.query(
      `INSERT INTO geocode_cache (address_key, lat, lng, precision, source, confidence) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (address_key) DO NOTHING`,
      [normalizeAddress(g.address), g.lat, g.lng, g.precision, g.source, g.confidence],
    );
  }

  return { sites: allSites.length, chargers: allChargers.length };
}

export async function loadGazetteer(seedDir: string): Promise<GazetteerEntry[]> {
  return (await readJson<{ entries: GazetteerEntry[] }>(seedDir, 'gazetteer.json')).entries;
}
