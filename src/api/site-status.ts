import type { Client } from '../db/pool.js';

// Live status rollup per site. Status is a state, not an event: a connector
// that has been Available for hours is fine. What ages is the vendor's last
// confirmation (last successful poll, or newest event time). A site not heard
// from within staleAfterSec is "Stale" and never recommended to anyone.

export type EffectiveStatus = string; // OCPP status, 'Faulted' (from a critical fault) or 'Unknown'
export type Rollup = 'Healthy' | 'Attention' | 'Faulted' | 'Stale';

export interface ConnectorView {
  chargerId: string;
  connectorId: string;
  model: string | null;
  maxKw: number;
  status: EffectiveStatus;
  reportedStatus: string | null;
  statusAt: string | null;
  fault: { code: string; severity: string; at: string } | null;
  powerW: number | null;
  energyWh: number | null;
  meterAt: string | null;
}

export interface SiteView {
  siteId: string;
  operatorId: string;
  name: string;
  address: string;
  timezone: string;
  synthetic: boolean;
  geocode: { status: string; precision: string | null; source: string | null; lat: number | null; lng: number | null };
  lastContact: { at: string | null; via: string | null; ageSec: number | null };
  stale: boolean;
  rollup: Rollup;
  connectors: ConnectorView[];
}

export interface SiteRow {
  site_id: string;
  operator_id: string;
  name: string;
  address: string;
  timezone: string;
  synthetic: boolean;
  geocode_status: string;
  geocode_precision: string | null;
  geocode_source: string | null;
  lat: number | null;
  lng: number | null;
  poll_contact_at: Date | null;
}

export interface ConnectorRow {
  site_id: string;
  charger_id: string;
  connector_id: string;
  model: string | null;
  max_kw: number;
  status: string | null;
  status_ts: Date | null;
  active_fault_code: string | null;
  active_fault_severity: string | null;
  active_fault_ts: Date | null;
  power_w: number | null;
  energy_wh: number | null;
  meter_ts: Date | null;
  last_seen_at: Date | null;
  last_seen_via: string | null;
}

export async function loadSiteViews(c: Client, asOf: Date, staleAfterSec: number, siteIds?: string[]): Promise<SiteView[]> {
  const filter = siteIds ? 'WHERE s.site_id = ANY($1)' : '';
  const params = siteIds ? [siteIds] : [];
  const sites = (
    await c.query<SiteRow>(
      `SELECT s.site_id, s.operator_id, s.name, s.address, s.timezone, s.synthetic,
              s.geocode_status, s.geocode_precision, s.geocode_source,
              ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
              ps.last_contact_at AS poll_contact_at
         FROM sites s LEFT JOIN poll_state ps ON ps.site_id = s.site_id
         ${filter}
        ORDER BY s.site_id`,
      params,
    )
  ).rows;
  const conns = (
    await c.query<ConnectorRow>(
      `SELECT cn.site_id, cn.charger_id, cn.connector_id, ch.model, ch.max_kw::float8 AS max_kw,
              cs.status, cs.status_ts, cs.active_fault_code, cs.active_fault_severity, cs.active_fault_ts,
              cs.power_w, cs.energy_wh, cs.meter_ts, cs.last_seen_at, cs.last_seen_via
         FROM connectors cn
         JOIN chargers ch ON ch.charger_id = cn.charger_id
         LEFT JOIN connector_state cs ON cs.charger_id = cn.charger_id AND cs.connector_id = cn.connector_id
        ${siteIds ? 'WHERE cn.site_id = ANY($1)' : ''}
        ORDER BY cn.charger_id, cn.connector_id`,
      params,
    )
  ).rows;
  return buildSiteViews(sites, conns, asOf, staleAfterSec);
}

export function effectiveStatus(r: Pick<ConnectorRow, 'status' | 'active_fault_severity'>): EffectiveStatus {
  if (r.active_fault_severity === 'critical') return 'Faulted';
  return r.status ?? 'Unknown';
}

export function buildSiteViews(sites: SiteRow[], conns: ConnectorRow[], asOf: Date, staleAfterSec: number): SiteView[] {
  const bySite = new Map<string, ConnectorRow[]>();
  for (const c of conns) {
    const list = bySite.get(c.site_id) ?? [];
    list.push(c);
    bySite.set(c.site_id, list);
  }
  return sites.map((s) => {
    const cs = bySite.get(s.site_id) ?? [];
    // Last vendor contact: the later of the last good poll page and the newest event.
    let contactAt: Date | null = s.poll_contact_at;
    let via: string | null = s.poll_contact_at ? 'poll' : null;
    for (const c of cs) {
      if (c.last_seen_at && (!contactAt || c.last_seen_at > contactAt)) {
        contactAt = c.last_seen_at;
        via = c.last_seen_via;
      }
    }
    const ageSec = contactAt ? Math.max(0, Math.round((asOf.getTime() - contactAt.getTime()) / 1000)) : null;
    const stale = ageSec === null || ageSec > staleAfterSec;

    const connectors: ConnectorView[] = cs.map((c) => ({
      chargerId: c.charger_id,
      connectorId: c.connector_id,
      model: c.model,
      maxKw: c.max_kw,
      status: effectiveStatus(c),
      reportedStatus: c.status,
      statusAt: c.status_ts?.toISOString() ?? null,
      fault:
        c.active_fault_code && c.active_fault_severity && c.active_fault_ts
          ? { code: c.active_fault_code, severity: c.active_fault_severity, at: c.active_fault_ts.toISOString() }
          : null,
      powerW: c.power_w,
      energyWh: c.energy_wh,
      meterAt: c.meter_ts?.toISOString() ?? null,
    }));

    let rollup: Rollup = 'Healthy';
    if (stale) rollup = 'Stale';
    else if (connectors.some((c) => c.status === 'Faulted')) rollup = 'Faulted';
    else if (connectors.some((c) => c.status === 'Unknown' || c.status === 'Unavailable' || c.fault)) rollup = 'Attention';

    return {
      siteId: s.site_id,
      operatorId: s.operator_id,
      name: s.name,
      address: s.address,
      timezone: s.timezone,
      synthetic: s.synthetic,
      geocode: { status: s.geocode_status, precision: s.geocode_precision, source: s.geocode_source, lat: s.lat, lng: s.lng },
      lastContact: { at: contactAt?.toISOString() ?? null, via, ageSec },
      stale,
      rollup,
      connectors,
    };
  });
}

// Bookable now: reported Available, no critical fault, and the site is fresh.
export function availableConnectors(site: SiteView): ConnectorView[] {
  if (site.stale) return [];
  return site.connectors.filter((c) => c.status === 'Available');
}

export function skipReason(site: SiteView): string {
  if (site.stale) {
    return site.lastContact.ageSec === null
      ? 'Stale: never heard from the vendor'
      : `Stale: last vendor contact ${Math.round(site.lastContact.ageSec / 60)} min ago`;
  }
  if (site.rollup === 'Faulted') return 'Faulted, nothing Available';
  if (site.rollup === 'Attention') return 'Needs attention, nothing Available';
  return 'Nothing Available';
}
