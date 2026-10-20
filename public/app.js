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

function locationLabel(geo) {
  if (geo.status !== 'resolved') return 'Location missing: not on the map';
  if (geo.source === 'manual_override') return 'Location verified';
  if (geo.precision === 'postal_code' || geo.precision === 'city') return 'Approximate location (postal area)';
  return 'Location from address';
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
    items.push({ rank: 5, synthetic: false, name: '', site: unplaced[0].siteId, text: `<b>${unplaced.length} site${unplaced.length === 1 ? '' : 's'}</b> can't be shown on the map: the address couldn't be located` });
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
    map.addSource('sites', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('point', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const color = ['match', ['get', 'rollup'], 'Healthy', ROLLUP.Healthy.color, 'Attention', ROLLUP.Attention.color, 'Faulted', ROLLUP.Faulted.color, ROLLUP.Stale.color];
    map.addLayer({
      id: 'halo',
      type: 'circle',
      source: 'sites',
      paint: {
        'circle-radius': ['match', ['get', 'geocodePrecision'], ...Object.entries(PRECISION_HALO).flat(), 8],
        'circle-color': color,
        'circle-opacity': 0.14,
      },
    });
    map.addLayer({
      id: 'sites',
      type: 'circle',
      source: 'sites',
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
      if (map.queryRenderedFeatures(e.point, { layers: ['sites'] }).length) return;
      state.point = { key: null, name: 'the point you clicked', lat: e.lngLat.lat, lng: e.lngLat.lng };
      void loadNearest();
    });
    map.on('mouseenter', 'sites', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'sites', () => (map.getCanvas().style.cursor = ''));
    state.mapReady = true;
    void refresh();
  });
  state.map = map;
}

function renderMap(geo) {
  const features = geo.features.filter((f) => state.showSynthetic || !f.properties.synthetic);
  const counts = {};
  for (const f of features) counts[f.properties.rollup] = (counts[f.properties.rollup] ?? 0) + 1;
  const unplaced = geo.unresolved.length;
  $('legend').innerHTML =
    Object.entries(ROLLUP)
      .map(([k, r]) => `<span><span class="dot" style="background:${r.color}"></span>${esc(r.label)} ${counts[k] ?? 0}</span>`)
      .join('') + (unplaced ? `<span>${unplaced} not on the map</span>` : '');
  if (!state.mapReady) return;
  state.map.getSource('sites').setData({ type: 'FeatureCollection', features });
  if (!state.fitted && features.length) {
    const b = new maplibregl.LngLatBounds();
    for (const f of features) b.extend(f.geometry.coordinates);
    state.map.fitBounds(b, { padding: 60, maxZoom: 12, duration: 0 });
    state.fitted = true;
  }
  renderSearchPoint();
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

async function renderAdmin() {
  const isAdmin = state.persona === 'platform_admin';
  $('admin').hidden = !isAdmin;
  $('not-admin').hidden = isAdmin;
  if (!isAdmin) return;
  const [calls, q] = await Promise.all([api('/v1/admin/csms-calls'), api('/v1/admin/quarantine')]);
  const interesting = calls.calls.filter((c) => c.status_code !== 200 || /S-IN-0007|S-DE-0003|S-IN-0012/.test(c.request) || c.direction === 'webhook');
  $('calls').innerHTML = interesting
    .slice(0, 40)
    .map((c) => {
      const tone = c.status_code >= 500 || c.status_code === 401 ? ['#B0302A', '#FBE9E7'] : c.status_code === 429 ? ['#7A4A00', '#FCF0DC'] : ['#176B5B', '#E1F2EE'];
      return `<div class="call"><div class="req">${esc(c.request)}</div>${pill(c.status_code ?? 'timeout', tone[0], tone[1])}<div class="how">${esc(c.handling)}</div></div>`;
    })
    .join('');
  $('quarantine').innerHTML = q.quarantine.length
    ? q.quarantine
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
    $('error').hidden = true;
    $('updated').textContent = `Updated ${new Date(status.asOf).toLocaleTimeString()} · refreshes every 5 s`;
    renderHealth(fresh);
    renderTiles(status, sessions.sessions);
    renderSites(status);
    renderAttention(status, sessions.sessions);
    renderMap(geo);
    renderSessions(sessions.sessions, statements.statements);
    renderFreshness(fresh);
    renderLog(events);
    await renderAdmin();
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
  await Promise.all([refresh(), loadNearest()]);
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
});

if (!PERSONAS[state.persona]) state.persona = 'acme-charge';
if (state.tab !== 'ops' && state.tab !== 'how') state.tab = 'ops';
initMap();
void switchPersona(state.persona);
setInterval(() => void refresh(), 5000);
