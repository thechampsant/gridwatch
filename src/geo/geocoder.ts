import type { Client } from '../db/pool.js';

// The vendor feed carries an address string and no coordinates, so the map
// depends on geocoding. It runs asynchronously at onboarding, never on the hot
// path, as a chain of steps (first hit wins):
//   1. manual override  - a human verified the pin (Indian addresses like
//                         "Metro Station, Gate 3" defeat most geocoders)
//   2. geocode cache    - earlier provider results, keyed by normalised address
//   3. provider         - a licensed geocoder whose terms allow storing results
//                         (not called in this slice: no network, no API key)
//   4. postal gazetteer - PIN / PLZ centroid; coarse, but honest about it
// Every result records its precision and source, so the map can show how
// good a pin is and support can see why. No result = "unresolved": the site
// is kept off the map and out of nearest-charger results, and queued for a human.

export type Precision = 'rooftop' | 'street' | 'landmark' | 'postal_code' | 'city';

export interface GeocodeInput {
  siteId: string;
  address: string;
  country: string;
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  precision: Precision;
  source: string;
  confidence: number;
  note: string; // why the pin is where it is, in plain words, shown to operators
}

export interface GeocodeStep {
  name: string;
  geocode(input: GeocodeInput): Promise<GeocodeResult | null>;
}

export async function geocodeChain(steps: GeocodeStep[], input: GeocodeInput): Promise<GeocodeResult | null> {
  for (const step of steps) {
    const r = await step.geocode(input);
    if (r) return r;
  }
  return null;
}

export function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// India: 6-digit PIN, first digit 1-9. Germany: 5-digit PLZ.
export function extractPostalCode(address: string, country: string): string | null {
  const re = country === 'IN' ? /\b([1-9]\d{5})\b/g : country === 'DE' ? /\b(\d{5})\b/g : null;
  if (!re) return null;
  const all = [...address.matchAll(re)].map((m) => m[1]!);
  return all.at(-1) ?? null; // postal codes come at the end of these addresses
}

// Why no location could be found, for the review list.
export function unresolvedReason(address: string, country: string): string {
  const code = extractPostalCode(address, country);
  return code ? `Postal code ${code} is not in the postal-code list` : 'No postal code in the address';
}

export class OverrideStep implements GeocodeStep {
  name = 'manual_override';
  constructor(private readonly c: Client) {}
  async geocode(input: GeocodeInput): Promise<GeocodeResult | null> {
    const r = await this.c.query(`SELECT lat, lng, precision, note FROM geocode_overrides WHERE site_id = $1`, [input.siteId]);
    const row = r.rows[0];
    return row
      ? { lat: row.lat, lng: row.lng, precision: row.precision, source: this.name, confidence: 1, note: `Pinned by operations: ${row.note}` }
      : null;
  }
}

export class CacheStep implements GeocodeStep {
  name = 'geocode_cache';
  constructor(private readonly c: Client) {}
  async geocode(input: GeocodeInput): Promise<GeocodeResult | null> {
    const r = await this.c.query(
      `SELECT lat, lng, precision, source, confidence::float8 AS confidence FROM geocode_cache WHERE address_key = $1`,
      [normalizeAddress(input.address)],
    );
    const row = r.rows[0];
    return row
      ? {
          lat: row.lat,
          lng: row.lng,
          precision: row.precision,
          source: row.source,
          confidence: row.confidence ?? 0.8,
          note: `Matched from the address at ${row.precision} level (${row.source})`,
        }
      : null;
  }
}

export interface GazetteerEntry {
  country: string;
  postal_code: string;
  place: string;
  lat: number;
  lng: number;
}

export class PostalGazetteerStep implements GeocodeStep {
  name = 'postal_gazetteer';
  private readonly index = new Map<string, GazetteerEntry>();
  constructor(entries: GazetteerEntry[]) {
    for (const e of entries) this.index.set(`${e.country}:${e.postal_code}`, e);
  }
  async geocode(input: GeocodeInput): Promise<GeocodeResult | null> {
    const code = extractPostalCode(input.address, input.country);
    if (!code) return null;
    const e = this.index.get(`${input.country}:${code}`);
    return e
      ? {
          lat: e.lat,
          lng: e.lng,
          precision: 'postal_code',
          source: this.name,
          confidence: 0.5,
          note: `Address matched only postal area ${code} (${e.place}); the pin is the area centre, about ±2 km`,
        }
      : null;
  }
}

// Geocode every site still pending. Idempotent: resolved sites are skipped.
export async function geocodePendingSites(c: Client, steps: GeocodeStep[]): Promise<{ resolved: number; unresolved: string[] }> {
  const { rows } = await c.query<{ site_id: string; address: string; country: string }>(
    `SELECT site_id, address, country FROM sites WHERE geocode_status = 'pending' ORDER BY site_id`,
  );
  let resolved = 0;
  const unresolved: string[] = [];
  for (const s of rows) {
    const r = await geocodeChain(steps, { siteId: s.site_id, address: s.address, country: s.country });
    if (r) {
      await c.query(
        `UPDATE sites SET location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, geocode_status = 'resolved',
                geocode_precision = $4, geocode_source = $5, geocode_confidence = $6, geocode_note = $7, geocoded_at = now()
          WHERE site_id = $1`,
        [s.site_id, r.lng, r.lat, r.precision, r.source, r.confidence, r.note],
      );
      resolved += 1;
    } else {
      // Not guessed: the site stays off the map, is still monitored and
      // billed, and waits in the review list for a human pin.
      const reason = unresolvedReason(s.address, s.country);
      await c.query(`UPDATE sites SET geocode_status = 'unresolved', geocode_note = $2, geocoded_at = now() WHERE site_id = $1`, [
        s.site_id,
        reason,
      ]);
      unresolved.push(`${s.site_id} (${reason})`);
    }
  }
  return { resolved, unresolved };
}
