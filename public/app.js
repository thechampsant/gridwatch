// GridWatch dashboard: a thin page over the real API. No build step.
// "Operations" speaks the control room's language; "How it works" keeps the
// pipeline evidence. The "view as" switch asks the demo-only /dev/token
// endpoint for a token; the server decides what each token can see.
'use strict';

const PERSONAS = {
  'acme-charge': {
    label: 'Acme Charge',
    role: 'Operator · India',
    title: 'Acme Charge Pvt Ltd',
    meta: 'India · prices in INR · times in IST',
    points: ['noida', 'blr'],
  },
  'stadtwerke-ev': {
    label: 'Stadtwerke EV',
    role: 'Operator · Germany',
    title: 'Stadtwerke EV GmbH',
    meta: 'Germany · prices in EUR · times in CET/CEST',
    points: ['stuttgart'],
  },
  platform_admin: {
    label: 'GridWatch admin',
    role: 'Platform · all operators',
    title: 'All operators',
    meta: 'GridWatch staff view · India and Germany · every query is audited',
    points: ['noida', 'blr', 'stuttgart'],
  },
};

const POINTS = {
  noida: { name: 'Noida Sector 62', lat: 28.628, lng: 77.3649 },
  blr: { name: 'Bengaluru MG Road', lat: 12.9756, lng: 77.6068 },
  stuttgart: { name: 'Stuttgart Schlossplatz', lat: 48.7784, lng: 9.18 },
};

// ---- Plain-language vocabulary -------------------------------------------

const ROLLUP = {
  Healthy: { label: 'All good', color: '#1D5FD0', fg: '#1D5FD0', bg: '#E5EDFB' },
  Attention: { label: 'Needs attention', color: '#E59A1F', fg: '#7A4A00', bg: '#FCF0DC' },
  Faulted: { label: 'Fault', color: '#C0362C', fg: '#B0302A', bg: '#FBE9E7' },
  Stale: { label: 'No recent data', color: '#9AA1AB', fg: '#5A616B', bg: '#ECEEF1' },
};
const STATUS = {
  Available: { label: 'Free', fg: '#1D5FD0', bg: '#E5EDFB', dot: '#1D5FD0' },
  Charging: { label: 'Charging', fg: '#5B33B3', bg: '#EEE8FA', dot: '#6A3FC1' },
  Occupied: { label: 'In use', fg: '#5B33B3', bg: '#EEE8FA', dot: '#6A3FC1' },
  Preparing: { label: 'Plugged in', fg: '#5B33B3', bg: '#EEE8FA', dot: '#6A3FC1' },
  SuspendedEV: { label: 'Paused', fg: '#5B33B3', bg: '#EEE8FA', dot: '#6A3FC1' },
  SuspendedEVSE: { label: 'Paused', fg: '#5B33B3', bg: '#EEE8FA', dot: '#6A3FC1' },
  Finishing: { label: 'Finishing', fg: '#5B33B3', bg: '#EEE8FA', dot: '#6A3FC1' },
  Reserved: { label: 'Reserved', fg: '#5A616B', bg: '#ECEEF1', dot: '#9AA1AB' },
  Faulted: { label: 'Fault', fg: '#B0302A', bg: '#FBE9E7', dot: '#C0362C' },
  Unavailable: { label: 'Out of service', fg: '#7A4A00', bg: '#FCF0DC', dot: '#E59A1F' },
  Unknown: { label: 'No data', fg: '#5A616B', bg: '#ECEEF1', dot: '#9AA1AB' },
};
const FAULTS = { OverTemperature: 'Overheating', GroundFailure: 'Ground fault', InternalError: 'Internal error' };
const REVIEW = {
  meter_reset: 'Meter was reset during the session',
  implausible_energy: 'More energy than this charger can deliver',
  start_missing: 'The session start never arrived',
  stop_missing: 'The session end never arrived',
  invalid_duration: 'Session ended before it started',
  no_tariff: 'No price is set for this site',
};
const OUTCOME = {
  applied: { label: 'Applied', fg: '#176B5B', bg: '#E1F2EE' },
  stale: { label: 'Stale', fg: '#5A616B', bg: '#ECEEF1' },
  duplicate: { label: 'Duplicate', fg: '#5B33B3', bg: '#EEE8FA' },
  quarantined: { label: 'Quarantined', fg: '#B0302A', bg: '#FBE9E7' },
  held: { label: 'Held', fg: '#7A4A00', bg: '#FCF0DC' },
};
const PRECISION_HALO = { rooftop: 4, street: 6, landmark: 9, postal_code: 26, city: 40 };

const statusOf = (s) => STATUS[s] ?? STATUS.Unknown;
const faultName = (code) => FAULTS[code] ?? String(code).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase());
// "C-IN-0007-A" -> "Charger A"
const chargerName = (id) => `Charger ${String(id).split('-').pop()}`;
const plugName = (c) => `${chargerName(c.chargerId)}, connector ${c.connectorId}`;

const isApproximate = (geo) => geo.precision === 'postal_code' || geo.precision === 'city';

function locationLabel(geo) {
  if (geo.status !== 'resolved') return 'Location missing: not on the map';
  // Pins entered by hand for this take-home say so; Cidroy's data has no coordinates.
  const demo = /demo value/.test(`${geo.source ?? ''} ${geo.note ?? ''}`) ? ' (demo value)' : '';
  if (geo.source === 'manual_override') return `Location verified${demo}`;
  if (isApproximate(geo)) return 'Approximate location (postal area)';
  return `Location from address${demo}`;
}

// "Address matched only postal area 201301 (Noida); ..." -> "201301 Noida"
function postalArea(note) {
  const m = /postal area (\d+) \(([^)]+)\)/.exec(note ?? '');
  return m ? `${m[1]} ${m[2]}` : 'an unknown area';
}

// ---- Formatting -----------------------------------------------------------

const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pill = (text, fg, bg) => `<span class="pill" style="color:${fg};background:${bg}">${esc(text)}</span>`;
const fmtNum = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const localeFor = (tz) => (tz === 'Asia/Kolkata' ? 'en-IN' : 'en-GB');

function fmtAge(sec) {
  if (sec === null || sec === undefined) return 'never';
  if (sec < 30) return 'just now';
  if (sec < 90) return `${Math.round(sec)} s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} days ago`;
}
// "9 Jun, 14:33 IST" in the site's own timezone.
function fmtTime(iso, tz) {
  if (!iso) return '–';
  return new Intl.DateTimeFormat(localeFor(tz), {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(iso));
}
function fmtClock(iso, tz) {
  return new Intl.DateTimeFormat(localeFor(tz), { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}
function fmtMoney(amount, currency) {
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-IE', { style: 'currency', currency }).format(Number(amount));
}
function fmtDay(dateStr) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${dateStr}T00:00:00Z`));
}

// ---- State and API --------------------------------------------------------

const state = {
  persona: readPref('gw.persona', 'acme-charge'),
  tab: readPref('gw.tab', 'ops'),
  token: null,
  point: null,
  // The brief's pilot is 50 sites; 47 are generated demo sites. Shown by default
  // so the view looks like a real network; every panel follows the toggle.
  showSynthetic: readPref('gw.synthetic', 'true') === 'true',
  map: null,
  mapReady: false,
  fitted: false,
  sites: new Map(),
  groupMarkers: new Map(), // "lng,lat" -> { el, marker, list } for sites sharing one approximate point
  pinning: null, // site ID an admin is placing on the map
  pinMessage: null,
  lastStatus: null,
  coverage: null, // /v1/coverage: hexagons, areas, countries
  gaps: null, // /v1/coverage/gaps
  layers: { density: readPref('gw.layer.density', 'false') === 'true', gaps: readPref('gw.layer.gaps', 'false') === 'true' },
  gapKm: [2, 5, 10].includes(Number(readPref('gw.gapkm', '5'))) ? Number(readPref('gw.gapkm', '5')) : 5,
};

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: preferences just don't persist */
  }
}

async function login(persona) {
  const r = await fetch('/dev/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ as: persona }),
  });
  if (!r.ok) throw new Error('could not get a demo login (is DEMO_MODE on?)');
  state.token = (await r.json()).token;
}

async function api(path) {
  const r = await fetch(path, { headers: { authorization: `Bearer ${state.token}` } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

// ---- Chrome: personas, tabs, header --------------------------------------

function renderChrome() {
  $('personas').innerHTML = Object.entries(PERSONAS)
    .map(
      ([id, p]) =>
        `<button type="button" data-persona="${id}" aria-pressed="${id === state.persona}"><span class="who">${esc(p.label)}</span><span class="role">${esc(p.role)}</span></button>`,
    )
    .join('');
  const p = PERSONAS[state.persona];
  $('scope-title').textContent = p.title;
  $('scope-meta').textContent = p.meta;
  $('points').innerHTML = p.points
    .map((k) => `<button type="button" data-point="${k}" aria-pressed="${state.point?.key === k}">${esc(POINTS[k].name)}</button>`)
    .join('');
  for (const t of ['ops', 'how']) {
    $(`tab-btn-${t}`).setAttribute('aria-selected', String(state.tab === t));
    $(`tab-btn-${t}`).tabIndex = state.tab === t ? 0 : -1;
    $(`tab-${t}`).hidden = state.tab !== t;
  }
}

function renderHealth(fresh) {
  const status = fresh.signals.find((s) => s.key === 'status')?.vendorAgeWhenServed;
  const ours = fresh.platform.p50Sec;
  const vendor = status ? `vendor delay ~${Math.round((status.minSec + status.maxSec) / 2)} s` : 'vendor delay unknown';
  const mine = ours === null ? '' : ` · our processing ${ours < 0.1 ? 'under 0.1 s' : `${ours.toFixed(1)} s`}`;
  $('health').innerHTML = `<span class="live-dot" aria-hidden="true"></span>Live data · ${esc(vendor)}${esc(mine)}`;
}

// ---- Operations tab --------------------------------------------------------

function latestBillingDay(sessions) {
  const days = sessions.map((s) => s.business_date ?? (s.stopped_at ? s.stopped_at.slice(0, 10) : null)).filter(Boolean).sort();
  return days.at(-1) ?? null;
}

const visibleSites = (status) => status.sites.filter((s) => state.showSynthetic || !s.synthetic);

function renderTiles(status, sessions) {
  const sites = visibleSites(status);
  const conns = sites.flatMap((s) => s.connectors);
  const count = (st) => conns.filter((c) => c.status === st).length;
  const charging = conns.filter((c) => c.status === 'Charging');
  const kw = charging.reduce((a, c) => a + (c.powerW ?? 0), 0) / 1000;
  const bySite = (r) => sites.filter((s) => s.rollup === r).length;
  const problemSites = sites.length - bySite('Healthy');

  const day = latestBillingDay(sessions);
  const ofDay = sessions.filter((s) => s.business_date === day || (!s.business_date && s.stopped_at?.slice(0, 10) === day));
  const billed = ofDay.filter((s) => s.billing_status === 'charged');
  const held = sessions.filter((s) => s.billing_status === 'needs_review');
  const totals = {};
  for (const s of billed) totals[s.currency] = (totals[s.currency] ?? 0) + Number(s.total_amount);
  const money = Object.entries(totals).map(([cur, v]) => fmtMoney(v, cur)).join(' + ') || fmtMoney(0, PERSONAS[state.persona].meta.includes('EUR') ? 'EUR' : 'INR');

  const tile = (label, value, unit, sub) =>
    `<div class="tile"><div class="tile-label">${esc(label)}</div><div><span class="tile-value">${esc(value)}</span><span class="tile-unit">${esc(unit)}</span></div><div class="tile-sub">${esc(sub)}</div></div>`;
  $('tiles').innerHTML =
    tile('Connectors free', fmtNum(count('Available')), `of ${fmtNum(conns.length)}`, `${fmtNum(count('Charging'))} charging · ${fmtNum(count('Faulted'))} with a fault · ${fmtNum(count('Unknown'))} no data`) +
    tile('Charging now', fmtNum(charging.length), charging.length === 1 ? 'car' : 'cars', `${fmtNum(kw)} kW being delivered right now`) +
    tile('Sites needing attention', fmtNum(problemSites), `of ${fmtNum(sites.length)}`, `${bySite('Faulted')} with a fault · ${bySite('Attention')} need a look · ${bySite('Stale')} no recent data`) +
    tile(day ? `Billed for ${fmtDay(day)}` : 'Billing', money, '', `${billed.length} session${billed.length === 1 ? '' : 's'} billed · ${held.length} held for review`);
}

// One line per site (its worst problem), so a site with many faulty
// connectors doesn't push everything else off the list.
function siteIssues(s) {
  if (s.stale) return [{ rank: 3, text: `no update from the network for ${fmtAge(s.lastContact.ageSec).replace(' ago', '')}` }];
  const issues = [];
  for (const c of s.connectors) {
    if (c.fault?.severity === 'critical' || c.status === 'Faulted') {
      const what = c.fault ? faultName(c.fault.code).toLowerCase() : 'fault';
      const since = c.fault?.at ?? c.statusAt;
      issues.push({ rank: 1, text: `${what} on ${plugName(c)}${since ? ` since ${fmtTime(since, s.timezone)}` : ''}` });
    } else if (c.fault) {
      issues.push({ rank: 2, text: `${faultName(c.fault.code).toLowerCase()} warning on ${plugName(c)}` });
    } else if (c.status === 'Unavailable') {
      issues.push({ rank: 2, text: `${plugName(c)} is out of service` });
    } else if (c.status === 'Unknown') {
      issues.push({ rank: 4, text: `no status received yet for ${plugName(c)}` });
    }
  }
  return issues.sort((a, b) => a.rank - b.rank);
}

function renderAttention(status, sessions) {
  const items = [];
  for (const s of visibleSites(status)) {
    const issues = siteIssues(s);
    if (!issues.length) continue;
    const more = issues.length - 1;
    items.push({
      rank: issues[0].rank,
      synthetic: s.synthetic,
      name: s.name,
      site: s.siteId,
      text: `<b>${esc(s.name)}</b>: ${esc(issues[0].text)}${more ? ` <span class="muted">(+${more} more)</span>` : ''}`,
    });
  }
  const held = sessions.filter((s) => s.billing_status === 'needs_review');
  if (held.length) {
    items.push({ rank: 2, synthetic: false, name: '', target: 'sess-h', text: `<b>${held.length} charging session${held.length === 1 ? '' : 's'}</b> held for billing review` });
  }
  const unplaced = visibleSites(status).filter((s) => s.geocode.status !== 'resolved');
  if (unplaced.length) {
    const reasons = [...new Set(unplaced.map((s) => (s.geocode.note ?? "the address couldn't be located").toLowerCase()))].join('; ');
    items.push({
      rank: 5,
      synthetic: false,
      name: '',
      target: 'loc-h',
      text: `<b>${unplaced.length} site${unplaced.length === 1 ? '' : 's'}</b> can't be shown on the map (${esc(reasons)})`,
    });
  }
  // Worst first; within a level, real pilot sites before generated demo sites.
  items.sort((a, b) => a.rank - b.rank || Number(a.synthetic) - Number(b.synthetic) || a.name.localeCompare(b.name));
  const tone = { 1: '#C0362C', 2: '#E59A1F', 3: '#9AA1AB', 4: '#9AA1AB', 5: '#9AA1AB' };
  const shown = items.slice(0, 12);
  $('attention').innerHTML = items.length
    ? shown
        .map(
          (i) =>
            `<li><button type="button" class="att" ${i.site ? `data-site="${esc(i.site)}"` : `data-target="${esc(i.target)}"`}><span class="dot" style="background:${tone[i.rank]}"></span><span>${i.text}</span></button></li>`,
        )
        .join('') + (items.length > shown.length ? `<li class="small muted">and ${items.length - shown.length} more</li>` : '')
    : '<li class="small muted">Nothing needs attention right now.</li>';
}

function connectorLine(c, tz) {
  if (c.fault && (c.fault.severity === 'critical' || c.status === 'Faulted')) return `${faultName(c.fault.code)} since ${fmtTime(c.fault.at, tz)}`;
  if (c.fault) return `${faultName(c.fault.code)} warning since ${fmtTime(c.fault.at, tz)}`;
  if (c.status === 'Charging' && c.powerW !== null) return `Charging at ${fmtNum(c.powerW / 1000, 1)} kW`;
  if (c.statusAt) return `${statusOf(c.status).label} since ${fmtTime(c.statusAt, tz)}`;
  return 'No status received yet';
}

// The chip shows what an operator acts on: a fault or warning beats the raw status.
function connectorChip(c) {
  if (c.status === 'Faulted' || c.fault?.severity === 'critical') return statusOf('Faulted');
  if (c.fault) return { label: 'Warning', fg: '#7A4A00', bg: '#FCF0DC' };
  return statusOf(c.status);
}

const ROLLUP_ORDER = { Faulted: 0, Attention: 1, Stale: 2, Healthy: 3 };

function renderSites(status) {
  state.sites = new Map(status.sites.map((s) => [s.siteId, s]));
  // Problems first, then real pilot sites before generated ones, then by name.
  const sites = visibleSites(status).sort(
    (a, b) => ROLLUP_ORDER[a.rollup] - ROLLUP_ORDER[b.rollup] || Number(a.synthetic) - Number(b.synthetic) || a.name.localeCompare(b.name),
  );
  const hidden = status.sites.length - sites.length;
  $('sites').innerHTML =
    sites
      .map((s) => {
        const r = ROLLUP[s.rollup];
        const free = s.connectors.filter((c) => c.status === 'Available').length;
        const conns = s.connectors
          .map((c) => {
            const st = connectorChip(c);
            return `<div class="conn"><div class="conn-head"><span>${esc(plugName(c))} <span class="muted small">${esc(fmtNum(c.maxKw))} kW</span></span>${pill(st.label, st.fg, st.bg)}</div><div class="small" style="color:var(--ink-2)">${esc(connectorLine(c, s.timezone))}</div></div>`;
          })
          .join('');
        return `<div class="site" id="site-${esc(s.siteId)}"><div class="site-head"><div><div class="site-name">${esc(s.name)}</div><div class="small muted">${esc(s.address)}</div><div class="small site-meta">${esc(free)} of ${esc(s.connectors.length)} connectors free · ${esc(locationLabel(s.geocode))} · Updated ${esc(fmtAge(s.lastContact.ageSec))} <span class="site-id">${esc(s.siteId)}</span></div></div>${pill(r.label, r.fg, r.bg)}</div>${conns}</div>`;
      })
      .join('') + (hidden ? `<div class="small muted">${hidden} demo site${hidden === 1 ? '' : 's'} hidden (generated to fill the pilot to 50 sites).</div>` : '');
}

function initMap() {
  if (state.map) return;
  if (typeof maplibregl === 'undefined') {
    $('map').innerHTML = '<div class="map-fallback">The map could not load (offline?). Everything else on this page still works.</div>';
    return;
  }
  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
    center: [78, 22],
    zoom: 3.5,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  // The container's size settles after fonts, layout and tab switches; keep the canvas in step.
  new ResizeObserver(() => map.resize()).observe($('map'));
  map.on('load', () => {
    // 'all' feeds the approximate-area halos; 'singles' the pins of sites that
    // have a point to themselves. Sites sharing one point get a count marker.
    map.addSource('all', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('singles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('point', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    // Coverage layers sit under the pins. Hexagons whose pins are only
    // postal-area centres get a dashed outline; so do uncertain gap cells.
    map.addSource('coverage', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('gaps', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'coverage-fill',
      type: 'fill',
      source: 'coverage',
      layout: { visibility: 'none' },
      paint: { 'fill-color': ['step', ['get', 'chargers'], DENSITY_STEPS[0][1], ...DENSITY_STEPS.slice(1).flat()], 'fill-opacity': 0.5 },
    });
    map.addLayer({ id: 'coverage-line', type: 'line', source: 'coverage', filter: ['!', ['get', 'approximate']], layout: { visibility: 'none' }, paint: { 'line-color': '#1D5FD0', 'line-width': 1.2 } });
    map.addLayer({
      id: 'coverage-line-approx',
      type: 'line',
      source: 'coverage',
      filter: ['get', 'approximate'],
      layout: { visibility: 'none' },
      paint: { 'line-color': '#1D5FD0', 'line-width': 1.2, 'line-dasharray': [2, 2] },
    });
    map.addLayer({
      id: 'gaps-fill',
      type: 'fill',
      source: 'gaps',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': ['match', ['get', 'kind'], 'static', GAP_KIND.static.color, GAP_KIND.live.color],
        'fill-opacity': ['case', ['get', 'uncertain'], 0.15, 0.32],
      },
    });
    map.addLayer({
      id: 'gaps-line',
      type: 'line',
      source: 'gaps',
      filter: ['get', 'uncertain'],
      layout: { visibility: 'none' },
      paint: { 'line-color': '#3E444D', 'line-width': 1, 'line-dasharray': [2, 2] },
    });
    const color = ['match', ['get', 'rollup'], 'Healthy', ROLLUP.Healthy.color, 'Attention', ROLLUP.Attention.color, 'Faulted', ROLLUP.Faulted.color, ROLLUP.Stale.color];
    map.addLayer({
      id: 'halo',
      type: 'circle',
      source: 'all',
      paint: {
        'circle-radius': ['match', ['get', 'geocodePrecision'], ...Object.entries(PRECISION_HALO).flat(), 8],
        'circle-color': color,
        'circle-opacity': 0.14,
      },
    });
    map.addLayer({
      id: 'sites',
      type: 'circle',
      source: 'singles',
      paint: { 'circle-radius': 7, 'circle-color': color, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
    });
    map.addLayer({
      id: 'point',
      type: 'circle',
      source: 'point',
      paint: { 'circle-radius': 9, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#16181D', 'circle-stroke-width': 3 },
    });
    map.on('click', 'sites', (e) => {
      const p = e.features[0].properties;
      const site = state.sites.get(p.siteId);
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `<b>${esc(p.name)}</b><br>${esc(ROLLUP[p.rollup]?.label ?? p.rollup)} · ${esc(p.connectorsAvailable)} of ${esc(p.connectorsTotal)} connectors free<br>Updated ${esc(fmtAge(p.lastContactAgeSec))} · ${esc(site ? locationLabel(site.geocode) : '')}`,
        )
        .addTo(map);
      highlightSite(p.siteId, false);
    });
    map.on('click', (e) => {
      if (e.originalEvent?.target?.closest?.('.group-pin')) return;
      if (state.pinning) {
        void savePin(state.pinning, e.lngLat);
        return;
      }
      if (map.queryRenderedFeatures(e.point, { layers: ['sites'] }).length) return;
      const cells = map.queryRenderedFeatures(e.point, { layers: ['gaps-fill', 'coverage-fill'] });
      if (cells.length) {
        openCellPopup(e.lngLat, cells);
        return;
      }
      state.point = { key: null, name: 'the point you clicked', lat: e.lngLat.lat, lng: e.lngLat.lng };
      void loadNearest();
    });
    map.on('mouseenter', 'sites', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'sites', () => (map.getCanvas().style.cursor = ''));
    state.mapReady = true;
    applyCoverageLayers();
    void refresh();
  });
  state.map = map;
}

// ---- Coverage and density --------------------------------------------------

// Fill colour by chargers in a hexagon (~36 km² at resolution 6).
const DENSITY_STEPS = [
  [1, '#DCE6F8'],
  [3, '#A9C1F0'],
  [6, '#6F95E3'],
  [11, '#2F63C9'],
];
const GAP_KIND = {
  static: { label: (km) => `No charger within ${km} km`, color: '#C0362C' },
  live: { label: (km) => `Chargers within ${km} km, none free right now`, color: '#E59A1F' },
};
const COUNTRY = { IN: 'India', DE: 'Germany' };

async function loadCoverage() {
  if (!state.token) return;
  const syn = `include_synthetic=${state.showSynthetic}`;
  try {
    const [cov, gaps] = await Promise.all([api(`/v1/coverage?res=6&${syn}`), api(`/v1/coverage/gaps?max_km=${state.gapKm}&${syn}`)]);
    state.coverage = cov;
    state.gaps = gaps;
    renderCoverage();
    applyCoverageLayers();
  } catch (err) {
    $('gaps').textContent = `Could not load coverage: ${err.message}`;
  }
}

function applyCoverageLayers() {
  renderLayerLegend();
  if (!state.mapReady) return;
  const m = state.map;
  if (state.coverage) m.getSource('coverage').setData(state.coverage.hexes);
  if (state.gaps) m.getSource('gaps').setData(state.gaps.gaps);
  for (const id of ['coverage-fill', 'coverage-line', 'coverage-line-approx']) m.setLayoutProperty(id, 'visibility', state.layers.density ? 'visible' : 'none');
  for (const id of ['gaps-fill', 'gaps-line']) m.setLayoutProperty(id, 'visibility', state.layers.gaps ? 'visible' : 'none');
}

function renderLayerLegend() {
  const parts = [];
  if (state.layers.density) {
    parts.push(
      ...DENSITY_STEPS.map(([from, c], i) => {
        const to = DENSITY_STEPS[i + 1]?.[0];
        return `<span><span class="swatch" style="background:${c}"></span>${to ? (to - 1 === from ? from : `${from}–${to - 1}`) : `${from}+`} chargers</span>`;
      }),
      '<span><span class="swatch dashed"></span>approximate pins</span>',
    );
  }
  if (state.layers.gaps) {
    parts.push(
      ...Object.values(GAP_KIND).map((g) => `<span><span class="swatch" style="background:${g.color};opacity:.6"></span>${esc(g.label(state.gapKm))}</span>`),
      '<span><span class="swatch dashed"></span>uncertain</span>',
    );
  }
  $('layer-legend').innerHTML = parts.join('');
}

function openCellPopup(lngLat, cells) {
  const gap = cells.find((f) => f.layer.id === 'gaps-fill')?.properties;
  const hex = cells.find((f) => f.layer.id === 'coverage-fill')?.properties;
  const lines = [];
  if (gap) {
    lines.push(`<b>${esc(GAP_KIND[gap.kind].label(state.gapKm))}</b>`);
    lines.push(`Nearest charger: ${esc(gap.nearestName)}, ${esc(fmtNum(gap.nearestKm, 1))} km`);
    if (gap.kind === 'live')
      lines.push(
        gap.nearestAvailableName ? `Nearest free and working: ${esc(gap.nearestAvailableName)}, ${esc(fmtNum(gap.nearestAvailableKm, 1))} km` : 'Nothing on your network is free and working right now',
      );
    if (gap.uncertain === true || gap.uncertain === 'true') lines.push('<span class="muted">Uncertain: that distance is to a postal-area centre (±2 km)</span>');
  }
  if (hex) {
    if (lines.length) lines.push('');
    lines.push(`<b>${esc(hex.sites)} site${Number(hex.sites) === 1 ? '' : 's'} in this hexagon</b> · ${esc(hex.chargers)} chargers · ${esc(hex.availableNow)} connectors free now`);
    if (hex.approximate === true || hex.approximate === 'true') lines.push('<span class="muted">Approximate: some pins are postal-area centres (±2 km)</span>');
  }
  new maplibregl.Popup().setLngLat(lngLat).setHTML(lines.join('<br>')).addTo(state.map);
}

function renderCoverage() {
  const cov = state.coverage;
  const g = state.gaps;
  if (!cov || !g) return;
  $('cov-summary').innerHTML =
    cov.countries
      .map(
        (c) =>
          `<b>${esc(COUNTRY[c.country] ?? c.country)}:</b> ${c.sites} sites · ${c.chargers} chargers · ${c.availableNow} connectors free now · in ${c.areas} area${c.areas === 1 ? '' : 's'}`,
      )
      .join('<br>') + (cov.unplacedSites ? `<br><span class="muted">${cov.unplacedSites} site${cov.unplacedSites === 1 ? '' : 's'} without a location ${cov.unplacedSites === 1 ? 'is' : 'are'} not counted.</span>` : '');
  $('areas').innerHTML =
    '<thead><tr><th>Area</th><th>Sites</th><th>Chargers</th><th>Per 1,000 km²</th><th>Free now</th></tr></thead><tbody>' +
    cov.areas
      .map(
        (a) =>
          `<tr><td><b>${esc(a.name)}</b>${a.alsoIncludes.length ? `<div class="small muted">also ${esc(a.alsoIncludes.join(', '))}</div>` : ''}${
            a.approximateSites ? `<div class="small muted">${a.approximateSites} of ${a.sites} pins approximate</div>` : ''
          }</td><td class="mono">${a.sites}</td><td class="mono">${a.chargers}</td><td class="mono">${esc(fmtNum(a.chargersPer1000Km2, 1))}</td><td class="mono">${a.availableNow}</td></tr>`,
      )
      .join('') +
    '</tbody>';
  const s = g.summary;
  const km2 = (x) => `${fmtNum(x)} km²`;
  $('gaps').innerHTML =
    `<p>Inside the ${g.clusters.length} metro area${g.clusters.length === 1 ? '' : 's'} your network serves (${km2(s.serviceAreaKm2)}): <b>${km2(s.staticGapKm2)}</b> ${
      s.staticGapKm2 === 1 ? 'is' : 'are'
    } more than ${g.maxKm} km from any charger, and <b>${km2(s.liveGapKm2)}</b> ${s.liveGapKm2 === 1 ? 'has' : 'have'} chargers within ${g.maxKm} km but none free and working right now.${
      s.uncertainCells ? ` ${s.uncertainCells} hexagon${s.uncertainCells === 1 ? ' is' : 's are'} uncertain, because the nearest pin is a postal-area centre.` : ''
    }</p>` +
    '<div class="table-scroll"><table class="sessions"><thead><tr><th>Metro area</th><th>Sites</th><th>No charger nearby</th><th>None free now</th></tr></thead><tbody>' +
    g.clusters
      .map((c) => `<tr><td><b>${esc(c.name)}</b>${c.alsoIncludes.length ? `<div class="small muted">also ${esc(c.alsoIncludes.join(', '))}</div>` : ''}</td><td class="mono">${c.sites}</td><td class="mono">${km2(c.staticGapKm2)}</td><td class="mono">${km2(c.liveGapKm2)}</td></tr>`)
      .join('') +
    '</tbody></table></div>' +
    `<p class="muted">Supply only: there is no demand data (population, traffic), so a gap means far from a charger, not proven demand. Distances are from hexagon centres (about 5 km² each).</p>`;
}

function renderMap(geo) {
  const features = geo.features.filter((f) => state.showSynthetic || !f.properties.synthetic);
  const counts = {};
  for (const f of features) counts[f.properties.rollup] = (counts[f.properties.rollup] ?? 0) + 1;
  const unplaced = geo.unresolved.filter((u) => state.showSynthetic || !state.sites.get(u.siteId)?.synthetic).length;
  $('legend').innerHTML =
    Object.entries(ROLLUP)
      .map(([k, r]) => `<span><span class="dot" style="background:${r.color}"></span>${esc(r.label)} ${counts[k] ?? 0}</span>`)
      .join('') + (unplaced ? `<span>${unplaced} not on the map</span>` : '');

  // Sites geocoded to the same postal-area centre share one exact point. Show
  // them honestly as one marker with a count, not spread out as if we knew better.
  const byPoint = new Map();
  for (const f of features) {
    const k = f.geometry.coordinates.join(',');
    if (!byPoint.has(k)) byPoint.set(k, []);
    byPoint.get(k).push(f);
  }
  const singles = [];
  const groups = [];
  for (const [k, list] of byPoint) (list.length === 1 ? singles.push(list[0]) : groups.push({ k, list }));
  const shared = groups.reduce((a, g) => a + g.list.length, 0);
  $('map-count').innerHTML =
    `<b>${features.length + unplaced} sites</b> · ${features.length} on the map · ${unplaced} without a location` +
    (groups.length ? ` · ${shared} of them share ${groups.length} approximate point${groups.length === 1 ? '' : 's'} (shown with a number)` : '');

  if (!state.mapReady) return;
  state.map.getSource('all').setData({ type: 'FeatureCollection', features });
  state.map.getSource('singles').setData({ type: 'FeatureCollection', features: singles });
  const seen = new Set();
  for (const g of groups) {
    seen.add(g.k);
    let m = state.groupMarkers.get(g.k);
    if (!m) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'group-pin';
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openGroupPopup(g.k);
      });
      m = { el, marker: new maplibregl.Marker({ element: el }).setLngLat(g.list[0].geometry.coordinates).addTo(state.map), list: g.list };
      state.groupMarkers.set(g.k, m);
    }
    m.list = g.list;
    const worst = g.list.map((f) => f.properties.rollup).sort((a, b) => ROLLUP_ORDER[a] - ROLLUP_ORDER[b])[0];
    m.el.textContent = String(g.list.length);
    m.el.style.background = ROLLUP[worst].color;
    m.el.setAttribute('aria-label', `${g.list.length} sites share this approximate location. Show them.`);
  }
  for (const [k, m] of state.groupMarkers) {
    if (!seen.has(k)) {
      m.marker.remove();
      state.groupMarkers.delete(k);
    }
  }
  if (!state.fitted && features.length) {
    const b = new maplibregl.LngLatBounds();
    for (const f of features) b.extend(f.geometry.coordinates);
    state.map.fitBounds(b, { padding: 60, maxZoom: 12, duration: 0 });
    state.fitted = true;
  }
  renderSearchPoint();
}

function openGroupPopup(k) {
  const m = state.groupMarkers.get(k);
  if (!m) return;
  const first = state.sites.get(m.list[0].properties.siteId);
  const rows = m.list
    .map((f) => `${esc(f.properties.name)} · ${esc(ROLLUP[f.properties.rollup]?.label ?? f.properties.rollup)} · ${esc(f.properties.connectorsAvailable)} of ${esc(f.properties.connectorsTotal)} free`)
    .join('<br>');
  new maplibregl.Popup()
    .setLngLat(m.list[0].geometry.coordinates)
    .setHTML(`<b>${m.list.length} sites share postal area ${esc(postalArea(first?.geocode.note))}</b><br><span class="muted">Exact positions unknown: the addresses matched only the postal area.</span><br>${rows}`)
    .addTo(state.map);
}

function renderSearchPoint() {
  if (!state.mapReady) return;
  state.map.getSource('point').setData({
    type: 'FeatureCollection',
    features: state.point ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [state.point.lng, state.point.lat] }, properties: {} }] : [],
  });
}

function highlightSite(siteId, fly = true) {
  const site = state.sites.get(siteId);
  if (fly && state.mapReady && site?.geocode.lat !== null && site?.geocode.lat !== undefined) {
    state.map.flyTo({ center: [site.geocode.lng, site.geocode.lat], zoom: 13 });
  }
  document.querySelectorAll('.site.highlight').forEach((el) => el.classList.remove('highlight'));
  const card = $(`site-${siteId}`);
  if (card) {
    card.classList.add('highlight');
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// The geocoding loop made visible: what we could place, how sure we are, and
// what happens to the sites we couldn't place (still monitored, waiting for a pin).
function renderLocations(status) {
  const sites = visibleSites(status);
  const missing = sites.filter((s) => s.geocode.status !== 'resolved');
  const approx = sites.filter((s) => s.geocode.status === 'resolved' && isApproximate(s.geocode));
  const exact = sites.filter((s) => s.geocode.status === 'resolved' && !isApproximate(s.geocode));
  const isAdmin = state.persona === 'platform_admin';
  $('loc-count').innerHTML = `<b>${sites.length} sites</b> · ${sites.length - missing.length} on the map · ${missing.length} without a location`;

  const missingHtml = missing.length
    ? missing
        .map(
          (s) =>
            `<div class="loc-row"><div><b>${esc(s.name)}</b> <span class="site-id">${esc(s.siteId)}</span></div><div class="small muted">${esc(s.address)}</div><div class="small"><b>Why:</b> ${esc(s.geocode.note ?? "The address couldn't be located")}</div><div class="small" style="color:var(--ink-2)">Still monitored and billed. Left out of the map and of find-a-free-charger until it is pinned.</div>${
              isAdmin
                ? `<button type="button" class="pin-btn" data-pin="${esc(s.siteId)}" aria-pressed="${state.pinning === s.siteId}">${state.pinning === s.siteId ? 'Now click the map…' : 'Pin on map'}</button>`
                : '<div class="small muted">Waiting for GridWatch operations to pin it.</div>'
            }</div>`,
        )
        .join('')
    : '<div class="small muted">Every site has a location.</div>';

  const groups = {};
  for (const s of approx) (groups[postalArea(s.geocode.note)] ??= []).push(s);
  const areas = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  const approxHtml = approx.length
    ? `<div class="small" style="color:var(--ink-2);padding-bottom:4px">Matched only to a postal area: the pin is the area centre, about ±2 km. Sites in the same area share one pin, and find-a-free-charger says "location approximate".</div>` +
      areas
        .slice(0, 8)
        .map(([k, list]) => `<div class="loc-line"><span>Postal area ${esc(k)}</span><span class="muted">${list.length} site${list.length === 1 ? '' : 's'}</span></div>`)
        .join('') +
      (areas.length > 8 ? `<div class="small muted">and ${areas.length - 8} more areas</div>` : '')
    : '<div class="small muted">None.</div>';

  const exactHtml = exact.length
    ? exact.map((s) => `<div class="loc-line"><span>${esc(s.name)}</span><span class="muted">${esc(locationLabel(s.geocode))}</span></div>`).join('')
    : '<div class="small muted">None yet.</div>';

  $('locations').innerHTML =
    `<div class="loc-col"><h3>Not on the map <span class="count">${missing.length}</span></h3>${missingHtml}</div>` +
    `<div class="loc-col"><h3>Approximate <span class="count">${approx.length}</span></h3>${approxHtml}</div>` +
    `<div class="loc-col"><h3>Street level or pinned <span class="count">${exact.length}</span></h3>${exactHtml}</div>`;

  const banner = $('pin-banner');
  if (state.pinning) {
    const s = state.sites.get(state.pinning);
    banner.hidden = false;
    banner.innerHTML = `Click the map where <b>${esc(s?.name ?? state.pinning)}</b> is. <button type="button" class="link-btn" data-pin-cancel>Cancel</button>`;
  } else if (state.pinMessage) {
    banner.hidden = false;
    banner.innerHTML = esc(state.pinMessage);
  } else {
    banner.hidden = true;
  }
  if (state.mapReady) $('map').classList.toggle('pinning', !!state.pinning);
}

async function savePin(siteId, lngLat) {
  const name = state.sites.get(siteId)?.name ?? siteId;
  try {
    // Six decimals is about 10 cm: more than a map click can mean.
    const round = (x) => Math.round(x * 1e6) / 1e6;
    await apiPost(`/v1/admin/sites/${encodeURIComponent(siteId)}/location`, { lat: round(lngLat.lat), lng: round(lngLat.lng) });
    state.pinMessage = `Saved: ${name} is now on the map as "Location verified". The pin is a manual override and wins over any geocoder result from now on.`;
  } catch (err) {
    state.pinMessage = `Not saved: ${err.message}. Pick a point inside the site's country.`;
  }
  state.pinning = null;
  await refresh();
}

function renderFailures(status, sessions, statements, events, adminData) {
  const sites = visibleSites(status);
  const held = (reason) => String(sessions.filter((s) => s.review_reason === reason).length);
  const calls = adminData?.calls ?? null;
  const q = adminData?.quarantine ?? null;
  const ADMIN = 'GridWatch admin only';
  const callCount = (pred) => (calls ? String(calls.filter(pred).length) : ADMIN);
  const qCount = (reasons) => (q ? String(q.filter((x) => reasons.includes(x.reason)).length) : ADMIN);
  const rows = [
    ['Network says "too many requests" (429)', 'Waits as long as the vendor asks (Retry-After) and resumes from the same page; no burst of retries', callCount((c) => c.status_code === 429), 'Vendor calls (admin)'],
    ['Network error or timeout (500)', 'Retries the same request up to 3 times with jittered backoff; if it keeps failing, tries again later without skipping any data', callCount((c) => c.direction === 'poll' && (c.status_code === null || c.status_code >= 500)), 'Vendor calls (admin)'],
    ['Broken record inside a batch', 'Sets that one record aside with the reason; the rest of the batch is still used', String(events.counts.quarantined ?? 0), 'Ingestion log'],
    ['Same update delivered twice', 'Recognised and ignored, so nothing is counted or billed twice', String(events.counts.duplicate ?? 0), 'Ingestion log'],
    ['Updates arrive out of order', 'The newest event wins by its own timestamp, not by arrival time', String(events.counts.stale ?? 0), 'Ingestion log'],
    ['Meter reset during a session', 'Rebuilt from interval readings when they allow it; otherwise held for review, never billed negative', held('meter_reset'), 'Sessions and billing'],
    ['More energy than the charger can deliver', 'Held for review instead of invoiced', held('implausible_energy'), 'Sessions and billing'],
    ['No coordinates in the feed (every site)', 'Placed from the address: verified pin, then geocoder, then postal-area centre, with how sure we are', `${sites.filter((s) => s.geocode.status === 'resolved').length} placed`, 'Site locations'],
    ['Address places a site only approximately', 'Approximate pin with a halo; sites sharing a point show a count; flagged in find-a-free-charger', String(sites.filter((s) => s.geocode.status === 'resolved' && isApproximate(s.geocode)).length), 'Site locations, map'],
    ['Address cannot be placed at all', 'Kept off the map, still monitored and billed, listed with the reason until operations pins it', String(sites.filter((s) => s.geocode.status !== 'resolved').length), 'Site locations'],
    ['No recent update from a site', 'Shown as "No recent data"; never recommended as a free charger', String(sites.filter((s) => s.stale).length), 'Map, Sites'],
    ["Charger unknown, or from another operator's feed", 'Rejected and set aside; never shown to the wrong operator', qCount(['unknown_charger', 'connection_mismatch', 'site_mismatch', 'unknown_connector']), 'Set-aside records (admin)'],
    ['Webhook with a bad signature', 'Rejected (401); nothing is stored', callCount((c) => c.outcome === 'bad_signature'), 'Vendor calls (admin)'],
    ['Day not finished, or data still arriving', "The daily statement waits until every site has reported past the operator's local midnight", statements.length ? `${statements.length} issued` : 'waiting', 'Sessions and billing'],
  ];
  $('failures').innerHTML =
    '<thead><tr><th>Failure</th><th>What GridWatch does</th><th>This run</th><th>Where to see it</th></tr></thead><tbody>' +
    rows.map(([f, what, n, where]) => `<tr><td><b>${esc(f)}</b></td><td>${esc(what)}</td><td class="mono">${esc(n)}</td><td>${esc(where)}</td></tr>`).join('') +
    '</tbody>';
}

function plainSkip(reason) {
  if (reason.startsWith('Stale')) return "but we haven't had an update from it recently";
  if (reason.startsWith('Faulted')) return 'but it has a fault';
  return 'but no connector is free';
}

async function loadNearest() {
  renderChrome();
  renderSearchPoint();
  if (!state.point) {
    $('nearest').innerHTML = '<div class="small muted">Pick a place above, or click anywhere on the map.</div>';
    return;
  }
  const { lat, lng, name } = state.point;
  try {
    const d = await api(`/v1/chargers/nearest?lat=${lat}&lng=${lng}&max_km=50&limit=1&include_synthetic=${state.showSynthetic}`);
    let html = `<div class="k">Nearest to ${esc(name)}</div>`;
    if (d.results.length) {
      const r = d.results[0];
      const approx = r.geocodePrecision === 'postal_code' || r.geocodePrecision === 'city';
      html += `<div><span class="near-name">${esc(r.name)}</span></div><div>${fmtNum(r.distanceKm, 1)} km away · ${r.available.length} connector${r.available.length === 1 ? '' : 's'} free${approx ? ' · location approximate' : ''}</div>`;
    } else {
      html += `<div class="near-name">No free connector within ${esc(d.maxKm)} km</div><div class="small">${
        d.nearestBeyondRadius
          ? `The nearest one is ${esc(d.nearestBeyondRadius.name)}, ${fmtNum(d.nearestBeyondRadius.distanceKm, 0)} km away.`
          : 'No connector in your network is free right now.'
      }</div>`;
    }
    if (d.skippedCloser.length) {
      html += d.skippedCloser
        .slice(0, 4)
        .map((s) => `<div class="skip"><span>${esc(s.name)} is closer (${fmtNum(s.distanceKm, 1)} km), ${esc(plainSkip(s.reason))}</span></div>`)
        .join('');
    }
    $('nearest').innerHTML = html;
  } catch (err) {
    $('nearest').innerHTML = `<div class="small">${esc(err.message)}</div>`;
  }
}

function sessionReason(s) {
  if (s.billing_status === 'charged') {
    return `Billed at ${fmtMoney(s.price_per_kwh, s.currency)} per kWh + ${fmtMoney(s.session_fee, s.currency)} session fee`;
  }
  if (s.billing_status === 'needs_review') {
    let text = REVIEW[s.review_reason] ?? 'Needs a manual check';
    const m = /about (\d+) kW average on a ([\d.]+) kW charger/.exec(s.review_detail ?? '');
    if (m) text += ` (about ${m[1]} kW on a ${m[2]} kW charger)`;
    return text;
  }
  if (s.billing_status === 'awaiting_start') return 'Waiting for the session start to arrive';
  return 'Charging in progress';
}

function renderSessions(sessions, statements) {
  $('statements').innerHTML = statements.length
    ? statements
        .map((s) => {
          const op = PERSONAS[s.operator_id]?.title ?? s.operator_id;
          return `<div class="statement"><div class="k">Daily statement · ${esc(fmtDay(s.business_date))}${state.persona === 'platform_admin' ? ` · ${esc(op)}` : ''}</div><div><b>${esc(fmtMoney(s.total_amount, s.currency))}</b> billed for ${esc(s.session_count)} session${s.session_count === 1 ? '' : 's'} (${fmtNum(Number(s.energy_wh) / 1000, 1)} kWh) · ${esc(s.held_count)} held for review</div></div>`;
        })
        .join('')
    : `<div class="small muted">No daily statement yet. It is issued once every site has reported past local midnight (or run: docker compose exec api node dist/bin/settle.js --date 2026-06-09).</div>`;
  const TONE = {
    charged: { label: 'Billed', fg: '#176B5B', bg: '#E1F2EE' },
    needs_review: { label: 'Held for review', fg: '#7A4A00', bg: '#FCF0DC' },
    awaiting_start: { label: 'Waiting', fg: '#5A616B', bg: '#ECEEF1' },
    open: { label: 'In progress', fg: '#5B33B3', bg: '#EEE8FA' },
  };
  if (!sessions.length) {
    $('sessions').innerHTML = '<tbody><tr><td class="muted">No charging sessions yet.</td></tr></tbody>';
    return;
  }
  $('sessions').innerHTML =
    '<thead><tr><th>Site</th><th>Charger</th><th>Time</th><th>Energy</th><th>Amount</th><th>Status</th></tr></thead><tbody>' +
    sessions
      .map((s) => {
        const t = TONE[s.billing_status] ?? TONE.open;
        const when = s.started_at
          ? `${fmtTime(s.started_at, s.timezone)} – ${s.stopped_at ? fmtClock(s.stopped_at, s.timezone) : 'now'}`
          : s.stopped_at
            ? `Ended ${fmtTime(s.stopped_at, s.timezone)}`
            : '–';
        const reported = s.start_meter_wh !== null && s.stop_meter_wh !== null && s.stop_meter_wh >= s.start_meter_wh ? (s.stop_meter_wh - s.start_meter_wh) / 1000 : null;
        const energy = s.energy_wh !== null ? `${fmtNum(Number(s.energy_wh) / 1000, 2)} kWh` : reported !== null ? `${fmtNum(reported, 2)} kWh reported` : '–';
        const amount = s.total_amount ? fmtMoney(s.total_amount, s.currency) : 'Not billed yet';
        return `<tr><td><b>${esc(s.site_name)}</b></td><td>${esc(chargerName(s.charger_id))}, connector ${esc(s.connector_id)}</td><td>${esc(when)}</td><td>${esc(energy)}</td><td>${esc(amount)}</td><td>${pill(t.label, t.fg, t.bg)}<div class="small" style="color:var(--ink-2);margin-top:4px">${esc(sessionReason(s))}</div></td></tr>`;
      })
      .join('') +
    '</tbody>';
}

// ---- How it works tab (technical evidence) --------------------------------

function renderFreshness(f) {
  const VERDICT = {
    missed_at_source: { text: 'Missed before it reaches us', color: '#B0302A', bar: '#C0362C' },
    ours_met: { text: 'Our part: met', color: '#1D5FD0', bar: 'transparent' },
    ours_at_risk: { text: 'Our part: at risk', color: '#B0302A', bar: 'transparent' },
    ours_no_data: { text: 'Our part', color: '#1D5FD0', bar: 'transparent' },
  };
  const pct = (s) => `${Math.min(100, Math.max(0, s))}%`;
  $('fresh').innerHTML = f.signals
    .map((s) => {
      const v = VERDICT[s.verdict] ?? VERDICT.missed_at_source;
      const a = s.vendorAgeWhenServed;
      const fill = a ? `<div class="fill" style="left:${pct(a.minSec)};width:${pct(Math.max(1, a.maxSec - a.minSec))};background:${v.bar}"></div>` : '';
      const observed = a
        ? `${fmtNum(a.minSec)}–${fmtNum(a.maxSec)} s old when the vendor handed it over (${a.samples} update${a.samples === 1 ? '' : 's'})`
        : s.verdict.startsWith('ours')
          ? 'From receipt to screen, inside GridWatch'
          : 'No samples yet';
      return `<div class="fresh-row"><div class="top-line"><b>${esc(s.signal)}</b><span class="muted">Target under ${esc(s.targetSec)} s · ${esc(s.percentile)}</span></div><div class="track" aria-hidden="true">${fill}<div class="tick" style="left:${pct(s.targetSec)}"></div></div><div class="bottom-line"><span style="color:var(--ink-2)">${esc(observed)}</span><b style="color:${v.color}">${esc(v.text)}</b></div><div class="small muted">${esc(s.vendorFloor)}</div></div>`;
    })
    .join('');
  const p = f.platform;
  $('platform').innerHTML = p.events
    ? `GridWatch's own share, from receipt to stored: ${fmtNum(p.p50Sec * 1000)} ms typical, ${fmtNum(p.p999Sec * 1000)} ms at the 99.9th percentile, over ${fmtNum(p.events)} updates. Vendor batches can add up to 60 s before we see anything, so the two parts are measured and reported separately.`
    : 'No updates processed yet.';
}

function renderLog(events) {
  $('outcomes').innerHTML = Object.entries(OUTCOME)
    .map(([k, o]) => pill(`${o.label} ${events.counts[k] ?? 0}`, o.fg, o.bg))
    .join('');
  $('log').innerHTML =
    '<thead><tr><th>#</th><th>Source</th><th>Event</th><th>Charger · conn</th><th>Event time</th><th>Outcome</th><th>Why</th></tr></thead><tbody>' +
    events.events
      .map((e, i) => {
        const o = OUTCOME[e.outcome];
        return `<tr><td class="mono muted">${i + 1}</td><td>${esc(e.sourceLabel)}</td><td>${esc(e.summary)}</td><td class="mono">${esc(e.charger_id ?? '')} · ${esc(e.connector_id ?? '?')}</td><td class="mono">${esc(e.event_ts_local ?? '')}</td><td>${pill(o.label, o.fg, o.bg)}</td><td style="color:var(--ink-2)">${esc(e.reason)}</td></tr>`;
      })
      .join('') +
    '</tbody>';
}

function renderAdmin(adminData) {
  const isAdmin = state.persona === 'platform_admin';
  $('admin').hidden = !isAdmin;
  $('not-admin').hidden = isAdmin;
  if (!isAdmin || !adminData) return;
  const { calls, quarantine } = adminData;
  const interesting = calls.filter((c) => c.status_code !== 200 || /S-IN-0007|S-DE-0003|S-IN-0012/.test(c.request) || c.direction === 'webhook');
  $('calls').innerHTML = interesting
    .slice(0, 40)
    .map((c) => {
      const tone = c.status_code >= 500 || c.status_code === 401 ? ['#B0302A', '#FBE9E7'] : c.status_code === 429 ? ['#7A4A00', '#FCF0DC'] : ['#176B5B', '#E1F2EE'];
      return `<div class="call"><div class="req">${esc(c.request)}</div>${pill(c.status_code ?? 'timeout', tone[0], tone[1])}<div class="how">${esc(c.handling)}</div></div>`;
    })
    .join('');
  $('quarantine').innerHTML = quarantine.length
    ? quarantine
        .map((x) => `<div class="call"><div class="req">${esc(JSON.stringify(x.payload ?? {}))}</div>${pill(x.reason, '#B0302A', '#FBE9E7')}<div class="how">${esc(x.detail ?? '')}</div></div>`)
        .join('')
    : '<div class="small muted">Empty.</div>';
}

// ---- Refresh loop ----------------------------------------------------------

async function refresh() {
  try {
    const [status, geo, sessions, statements, events, fresh] = await Promise.all([
      api('/v1/sites/status'),
      api('/v1/map/sites'),
      api('/v1/sessions'),
      api('/v1/settlement/statements'),
      api('/v1/ingestion/events'),
      api('/v1/freshness'),
    ]);
    // Vendor calls and set-aside records are admin-only; operators get 403, so don't ask.
    const adminData =
      state.persona === 'platform_admin'
        ? await Promise.all([api('/v1/admin/csms-calls'), api('/v1/admin/quarantine')]).then(([c, q]) => ({ calls: c.calls, quarantine: q.quarantine }))
        : null;
    state.lastStatus = status;
    $('error').hidden = true;
    $('updated').textContent = `Updated ${new Date(status.asOf).toLocaleTimeString()} · refreshes every 5 s`;
    renderHealth(fresh);
    renderTiles(status, sessions.sessions);
    renderSites(status);
    renderAttention(status, sessions.sessions);
    renderMap(geo);
    renderLocations(status);
    renderSessions(sessions.sessions, statements.statements);
    renderFailures(status, sessions.sessions, statements.statements, events, adminData);
    renderFreshness(fresh);
    renderLog(events);
    renderAdmin(adminData);
  } catch (err) {
    $('error').hidden = false;
    $('error').textContent = `Could not load data: ${err.message}`;
  }
}

async function switchPersona(persona) {
  state.persona = persona;
  writePref('gw.persona', persona);
  const first = PERSONAS[persona].points[0];
  state.point = { key: first, ...POINTS[first] };
  state.fitted = false;
  renderChrome();
  await login(persona);
  await Promise.all([refresh(), loadNearest(), loadCoverage()]);
}

function switchTab(tab) {
  state.tab = tab;
  writePref('gw.tab', tab);
  renderChrome();
  if (tab === 'ops' && state.mapReady) state.map.resize();
}

document.addEventListener('click', (e) => {
  const el = (sel) => e.target.closest(sel);
  if (el('[data-persona]')) void switchPersona(el('[data-persona]').dataset.persona);
  if (el('[data-tab]')) switchTab(el('[data-tab]').dataset.tab);
  if (el('[data-point]')) {
    const k = el('[data-point]').dataset.point;
    state.point = { key: k, ...POINTS[k] };
    void loadNearest();
  }
  if (el('[data-pin]')) {
    const id = el('[data-pin]').dataset.pin;
    state.pinning = state.pinning === id ? null : id;
    state.pinMessage = null;
    if (state.lastStatus) renderLocations(state.lastStatus);
    if (state.pinning) $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (el('[data-pin-cancel]')) {
    state.pinning = null;
    if (state.lastStatus) renderLocations(state.lastStatus);
    return;
  }
  if (el('[data-site]')) highlightSite(el('[data-site]').dataset.site);
  if (el('[data-target]')) $(el('[data-target]').dataset.target)?.scrollIntoView({ behavior: 'smooth' });
});
// Arrow keys move between tabs, as tab lists usually do.
document.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const next = state.tab === 'ops' ? 'how' : 'ops';
  switchTab(next);
  $(`tab-btn-${next}`).focus();
});
$('show-synthetic').checked = state.showSynthetic;
$('show-synthetic').addEventListener('change', (e) => {
  state.showSynthetic = e.target.checked;
  writePref('gw.synthetic', String(state.showSynthetic));
  state.fitted = false;
  void refresh();
  void loadNearest();
  void loadCoverage();
});
for (const [key, id] of [
  ['density', 'layer-density'],
  ['gaps', 'layer-gaps'],
]) {
  $(id).checked = state.layers[key];
  $(id).addEventListener('change', (e) => {
    state.layers[key] = e.target.checked;
    writePref(`gw.layer.${key}`, String(e.target.checked));
    applyCoverageLayers();
  });
}
$('gap-km').value = String(state.gapKm);
$('gap-km').addEventListener('change', (e) => {
  state.gapKm = Number(e.target.value);
  writePref('gw.gapkm', String(state.gapKm));
  void loadCoverage();
});

if (!PERSONAS[state.persona]) state.persona = 'acme-charge';
if (state.tab !== 'ops' && state.tab !== 'how') state.tab = 'ops';
initMap();
void switchPersona(state.persona);
setInterval(() => void refresh(), 5000);
setInterval(() => void loadCoverage(), 60000);
