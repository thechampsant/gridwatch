import type { Client } from '../db/pool.js';
import { cityFromAddress } from './geocoder.js';

// Coverage and density on the H3 hexagon grid (Part A §7.2). Every query runs
// inside the caller's tenant, so an operator only ever counts its own network.
//
// Two honesty rules shape this:
// - Most pins are postal-area centres (±2 km, about 12.6 km² of uncertainty).
//   Binning them into cells smaller than that would be false precision, so
//   density stops at resolution 6 (~36 km²).
// - There is no demand data (population, traffic, POIs), so a "gap" here means
//   far from supply, not proven demand.

export const AREA_RES = 4; // ~1,770 km²: the "regions" a density table is quoted for
export const GAP_RES = 7; // ~5 km²: fine enough to measure distance to a charger
const DENSITY_RES_MIN = 4;
const DENSITY_RES_MAX = 6;
const MAX_GAP_CELLS = 5000;
const APPROXIMATE = new Set(['postal_code', 'city']);
// Average H3 cell areas, for messages only; real areas come from h3_cell_area.
const AVG_CELL_KM2: Record<number, number> = { 4: 1770, 5: 253, 6: 36, 7: 5.2, 8: 0.74, 9: 0.11 };

export class CoverageError extends Error {}

export function densityResError(res: number): string | null {
  if (!Number.isInteger(res) || res < DENSITY_RES_MIN) return `res must be a whole number from ${DENSITY_RES_MIN} to ${DENSITY_RES_MAX}`;
  if (res > DENSITY_RES_MAX) {
    const km2 = AVG_CELL_KM2[res];
    return `Resolution ${res} cells (${km2 ? `about ${km2} km²` : 'very small'}) are smaller than a postal-area pin's uncertainty (±2 km, about 12.6 km²), so counts per cell would be false precision. Use ${DENSITY_RES_MIN}–${DENSITY_RES_MAX}.`;
  }
  return null;
}

interface SiteCellRow {
  site_id: string;
  name: string;
  country: string;
  address: string;
  precision: string | null;
  cell: string;
  area: string;
  chargers: number;
  connectors: number;
}

interface CellShape {
  cell: string;
  km2: number;
  boundary: unknown;
}

async function cellShapes(c: Client, cells: string[]): Promise<Map<string, CellShape>> {
  const rows = (
    await c.query<CellShape>(
      `SELECT x AS cell, h3_cell_area(x::h3index, 'km^2') AS km2,
              ST_AsGeoJSON(h3_cell_to_boundary_geometry(x::h3index), 6)::json AS boundary
         FROM unnest($1::text[]) x`,
      [cells],
    )
  ).rows;
  return new Map(rows.map((r) => [r.cell, r]));
}

const round = (x: number, dp = 1) => Math.round(x * 10 ** dp) / 10 ** dp;

function mostCommon(values: (string | null)[]): { name: string; others: string[] } {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { name: sorted[0]?.[0] ?? 'Unnamed area', others: sorted.slice(1).map(([k]) => k) };
}

export interface DensityOptions {
  res: number;
  includeSynthetic: boolean;
  available: Map<string, number>; // site ID -> connectors free and working now
}

export async function hexDensity(c: Client, o: DensityOptions) {
  const sites = (
    await c.query<SiteCellRow>(
      `SELECT s.site_id, s.name, s.country, s.address, s.geocode_precision AS precision,
              h3_latlng_to_cell(s.location::geometry, $1)::text AS cell,
              h3_latlng_to_cell(s.location::geometry, $3)::text AS area,
              (SELECT count(*)::int FROM chargers ch WHERE ch.site_id = s.site_id) AS chargers,
              (SELECT count(*)::int FROM connectors cn WHERE cn.site_id = s.site_id) AS connectors
         FROM sites s
        WHERE s.location IS NOT NULL AND ($2 OR NOT s.synthetic)
        ORDER BY s.site_id`,
      [o.res, o.includeSynthetic, AREA_RES],
    )
  ).rows;
  const shapes = await cellShapes(c, [...new Set([...sites.map((s) => s.cell), ...sites.map((s) => s.area)])]);

  const group = <K extends 'cell' | 'area' | 'country'>(key: K) => {
    const m = new Map<string, SiteCellRow[]>();
    for (const s of sites) m.set(s[key], [...(m.get(s[key]) ?? []), s]);
    return m;
  };
  const tally = (list: SiteCellRow[]) => ({
    sites: list.length,
    chargers: list.reduce((n, s) => n + s.chargers, 0),
    connectors: list.reduce((n, s) => n + s.connectors, 0),
    availableNow: list.reduce((n, s) => n + (o.available.get(s.site_id) ?? 0), 0),
    approximateSites: list.filter((s) => APPROXIMATE.has(s.precision ?? '')).length,
  });

  const features = [...group('cell').entries()].map(([cell, list]) => {
    const t = tally(list);
    const shape = shapes.get(cell)!;
    return {
      type: 'Feature' as const,
      id: cell,
      geometry: shape.boundary,
      properties: {
        cell,
        country: list[0]!.country,
        ...t,
        approximate: t.approximateSites > 0,
        areaKm2: round(shape.km2),
        siteIds: list.map((s) => s.site_id),
      },
    };
  });

  const areas = [...group('area').entries()]
    .map(([area, list]) => {
      const t = tally(list);
      const km2 = shapes.get(area)!.km2;
      const place = mostCommon(list.map((s) => cityFromAddress(s.address, s.country)));
      return {
        area,
        name: place.name,
        alsoIncludes: place.others,
        country: list[0]!.country,
        areaKm2: Math.round(km2),
        ...t,
        chargersPer1000Km2: round((t.chargers / km2) * 1000),
      };
    })
    .sort((a, b) => b.chargers - a.chargers || a.name.localeCompare(b.name));

  const countries = [...group('country').entries()].map(([country, list]) => ({
    country,
    ...tally(list),
    areas: new Set(list.map((s) => s.area)).size,
  }));

  return {
    res: o.res,
    cellAreaKm2: AVG_CELL_KM2[o.res],
    areaRes: AREA_RES,
    hexes: { type: 'FeatureCollection' as const, features },
    areas,
    countries,
  };
}

export interface GapOptions {
  maxKm: number;
  includeSynthetic: boolean;
  availableSiteIds: string[];
}

interface GapCellRow {
  cell: string;
  cid: number;
  km2: number;
  boundary: unknown;
  nearest_site: string;
  nearest_precision: string | null;
  nearest_m: number;
  avail_site: string | null;
  avail_precision: string | null;
  avail_m: number | null;
}

// The service area is where the network already operates: sites grouped into
// metro clusters (DBSCAN, ~25 km in Web Mercator, about 17-22 km on the ground
// at these latitudes), each cluster's convex hull plus 2 km, filled with
// resolution-7 cells. For every cell, the distance to the nearest charger of
// any kind and to the nearest one that is free and working right now.
const SITES_SQL = `
  s AS (SELECT site_id, name, address, country, geocode_precision AS precision, location
          FROM sites WHERE location IS NOT NULL AND ($1 OR NOT synthetic)),
  cl AS (SELECT site_id, name, address, country, location,
                ST_ClusterDBSCAN(ST_Transform(location::geometry, 3857), eps := 25000, minpoints := 1) OVER () AS cid
           FROM s)`;

export async function coverageGaps(c: Client, o: GapOptions) {
  const members = (
    await c.query<{ site_id: string; name: string; address: string; country: string; cid: number }>(
      `WITH ${SITES_SQL} SELECT site_id, name, address, country, cid FROM cl ORDER BY cid, site_id`,
      [o.includeSynthetic],
    )
  ).rows;
  const cells = (
    await c.query<GapCellRow>(
      `WITH ${SITES_SQL},
       hull AS (SELECT cid, ST_Buffer(ST_ConvexHull(ST_Collect(location::geometry))::geography, 2000)::geometry AS g
                  FROM cl GROUP BY cid),
       cells AS (SELECT DISTINCT ON (cell) cell, cid
                   FROM (SELECT h3_polygon_to_cells(g, $3) AS cell, cid FROM hull) x
                  ORDER BY cell, cid)
       SELECT cells.cell::text AS cell, cells.cid, h3_cell_area(cells.cell, 'km^2') AS km2,
              ST_AsGeoJSON(h3_cell_to_boundary_geometry(cells.cell), 6)::json AS boundary,
              n.site_id AS nearest_site, n.precision AS nearest_precision, n.dist_m AS nearest_m,
              a.site_id AS avail_site, a.precision AS avail_precision, a.dist_m AS avail_m
         FROM cells
        CROSS JOIN LATERAL (SELECT ST_SetSRID(h3_cell_to_geometry(cells.cell), 4326)::geography AS p) cp
        CROSS JOIN LATERAL (SELECT s.site_id, s.precision, ST_Distance(s.location, cp.p)::float8 AS dist_m
                              FROM s ORDER BY s.location <-> cp.p LIMIT 1) n
         LEFT JOIN LATERAL (SELECT s.site_id, s.precision, ST_Distance(s.location, cp.p)::float8 AS dist_m
                              FROM s WHERE s.site_id = ANY($2::text[]) ORDER BY s.location <-> cp.p LIMIT 1) a ON true
        LIMIT $4`,
      [o.includeSynthetic, o.availableSiteIds, GAP_RES, MAX_GAP_CELLS + 1],
    )
  ).rows;
  if (cells.length > MAX_GAP_CELLS) throw new CoverageError(`the service area is over ${MAX_GAP_CELLS} cells; narrow the query`);

  const names = new Map(members.map((m) => [m.site_id, m.name]));
  const maxM = o.maxKm * 1000;
  const within = (m: number | null) => m !== null && m <= maxM;
  const classified = cells.map((r) => {
    const kind = !within(r.nearest_m) ? 'static' : !within(r.avail_m) ? 'live' : 'covered';
    // The verdict hangs on one distance; if that pin is a postal-area centre
    // (±2 km) and the distance is within 2 km of the limit, it could go either way.
    const ref = kind === 'static' ? { m: r.nearest_m, p: r.nearest_precision } : { m: r.avail_m, p: r.avail_precision };
    const uncertain = ref.m !== null && APPROXIMATE.has(ref.p ?? '') && Math.abs(ref.m - maxM) < 2000;
    return { ...r, kind, uncertain };
  });

  const km2 = (list: typeof classified) => round(list.reduce((n, r) => n + r.km2, 0));
  const clusters = [...new Set(members.map((m) => m.cid))].map((cid) => {
    const sites = members.filter((m) => m.cid === cid);
    const inCluster = classified.filter((r) => r.cid === cid);
    const place = mostCommon(sites.map((s) => cityFromAddress(s.address, s.country)));
    return {
      name: place.name,
      alsoIncludes: place.others,
      country: sites[0]!.country,
      sites: sites.length,
      serviceAreaKm2: km2(inCluster),
      staticGapKm2: km2(inCluster.filter((r) => r.kind === 'static')),
      liveGapKm2: km2(inCluster.filter((r) => r.kind === 'live')),
    };
  });

  const gaps = classified.filter((r) => r.kind !== 'covered');
  return {
    maxKm: o.maxKm,
    res: GAP_RES,
    cellAreaKm2: AVG_CELL_KM2[GAP_RES],
    note: 'Supply only: there is no demand data (population, traffic), so a gap means far from a charger, not proven demand.',
    summary: {
      cells: classified.length,
      serviceAreaKm2: km2(classified),
      coveredKm2: km2(classified.filter((r) => r.kind === 'covered')),
      staticGapKm2: km2(classified.filter((r) => r.kind === 'static')),
      liveGapKm2: km2(classified.filter((r) => r.kind === 'live')),
      uncertainCells: gaps.filter((r) => r.uncertain).length,
    },
    clusters: clusters.sort((a, b) => b.sites - a.sites || a.name.localeCompare(b.name)),
    gaps: {
      type: 'FeatureCollection' as const,
      features: gaps.map((r) => ({
        type: 'Feature' as const,
        id: r.cell,
        geometry: r.boundary,
        properties: {
          cell: r.cell,
          kind: r.kind,
          uncertain: r.uncertain,
          nearestSite: r.nearest_site,
          nearestName: names.get(r.nearest_site) ?? r.nearest_site,
          nearestKm: round(r.nearest_m / 1000),
          nearestAvailableSite: r.avail_site,
          nearestAvailableName: r.avail_site ? (names.get(r.avail_site) ?? r.avail_site) : null,
          nearestAvailableKm: r.avail_m === null ? null : round(r.avail_m / 1000),
        },
      })),
    },
  };
}
