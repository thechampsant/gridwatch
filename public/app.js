// GridWatch dashboard: a thin page over the real API. No build step.
// Each panel reads one endpoint. The "view as" switch asks the demo-only
// /dev/token endpoint for a token; the server decides what each token sees.
'use strict';

const PERSONAS = {
  'acme-charge': {
    label: 'Acme Charge',
    role: 'Operator · India',
    title: 'Acme Charge Pvt Ltd',
    meta: 'Operator view · India · INR · Asia/Kolkata',
    note: 'Only Acme sites, sessions and events appear here. A Stadtwerke login calling the same API gets Stadtwerke data, whatever the URL says.',
    points: ['noida', 'blr'],
  },
  'stadtwerke-ev': {
    label: 'Stadtwerke EV',
    role: 'Operator · Germany',
    title: 'Stadtwerke EV GmbH',
    meta: 'Operator view · Germany · EUR · Europe/Berlin',
    note: 'Only Stadtwerke sites, sessions and events appear here. Acme data is filtered out in the database (row-level security), not in the browser.',
    points: ['stuttgart'],
  },
  platform_admin: {
    label: 'GridWatch admin',
    role: 'Platform · all tenants',
    title: 'All tenants',
    meta: 'Platform admin view · India and Germany',
    note: 'Cross-tenant access for GridWatch staff only. Every query from this role is written to the audit log.',
    points: ['noida', 'blr', 'stuttgart'],
  },
};

const POINTS = {
  noida: { name: 'Noida Sector 62', lat: 28.628, lng: 77.3649 },
  blr: { name: 'Bengaluru MG Road', lat: 12.9756, lng: 77.6068 },
  stuttgart: { name: 'Stuttgart Schlossplatz', lat: 48.7784, lng: 9.18 },
};

const ROLLUP = {
  Healthy: { label: 'Healthy', color: '#1D5FD0', fg: '#1D5FD0', bg: '#E5EDFB' },
  Attention: { label: 'Needs attention', color: '#E59A1F', fg: '#7A4A00', bg: '#FCF0DC' },
  Faulted: { label: 'Faulted', color: '#C0362C', fg: '#B0302A', bg: '#FBE9E7' },
  Stale: { label: 'Stale', color: '#9AA1AB', fg: '#5A616B', bg: '#ECEEF1' },
};
const STATUS = {
  Available: { fg: '#1D5FD0', bg: '#E5EDFB', dot: '#1D5FD0' },
  Charging: { fg: '#5B33B3', bg: '#EEE8FA', dot: '#6A3FC1' },
  Faulted: { fg: '#B0302A', bg: '#FBE9E7', dot: '#C0362C' },
  Unknown: { fg: '#5A616B', bg: '#ECEEF1', dot: '#9AA1AB' },
};
const OUTCOME = {
  applied: { label: 'Applied', fg: '#176B5B', bg: '#E1F2EE' },
  stale: { label: 'Stale', fg: '#5A616B', bg: '#ECEEF1' },
  duplicate: { label: 'Duplicate', fg: '#5B33B3', bg: '#EEE8FA' },
  quarantined: { label: 'Quarantined', fg: '#B0302A', bg: '#FBE9E7' },
  held: { label: 'Held', fg: '#7A4A00', bg: '#FCF0DC' },
};
const PRECISION_HALO = { rooftop: 4, street: 6, landmark: 9, postal_code: 26, city: 40 };

const state = {
  persona: readPref('gw.persona', 'acme-charge'),
  token: null,
  point: null,
  showSynthetic: readPref('gw.synthetic', 'false') === 'true',
  map: null,
  mapReady: false,
  fitted: false,
  timer: null,
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

const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pill = (text, fg, bg) => `<span class="pill" style="color:${fg};background:${bg}">${esc(text)}</span>`;
const fmtNum = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
function fmtAge(sec) {
  if (sec === null || sec === undefined) return 'never';
  if (sec < 90) return `${Math.round(sec)} s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} days ago`;
}
function fmtLocal(iso, tz) {
  if (!iso) return '–';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

async function login(persona) {
  const r = await fetch('/dev/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ as: persona }),
  });
  if (!r.ok) throw new Error('could not get a demo token (is DEMO_MODE on?)');
  state.token = (await r.json()).token;
}

async function api(path) {
  const r = await fetch(path, { headers: { authorization: `Bearer ${state.token}` } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

function renderPersonas() {
  $('personas').innerHTML = Object.entries(PERSONAS)
    .map(
      ([id, p]) =>
        `<button type="button" data-persona="${id}" aria-pressed="${id === state.persona}"><span class="who">${esc(p.label)}</span><span class="role">${esc(p.role)}</span></button>`,
    )
    .join('');
  const p = PERSONAS[state.persona];
  $('scope-title').textContent = p.title;
  $('scope-meta').textContent = p.meta;
  $('scope-note').textContent = p.note;
  $('points').innerHTML = p.points
    .map((k) => `<button type="button" data-point="${k}" aria-pressed="${state.point?.key === k}">${esc(POINTS[k].name)}</button>`)
    .join('');
}

function renderTiles(status, sessions, events) {
  const t = status.totals;
  const charged = sessions.filter((s) => s.billing_status === 'charged');
  const held = sessions.filter((s) => s.billing_status === 'needs_review');
  const kwh = charged.reduce((a, s) => a + Number(s.energy_wh) / 1000, 0);
  const dups = events.counts.duplicate ?? 0;
  const reasons = {};
  for (const s of held) reasons[s.review_reason] = (reasons[s.review_reason] ?? 0) + 1;
  const tile = (label, value, unit, sub) =>
    `<div class="tile"><div class="tile-label">${esc(label)}</div><div><span class="tile-value">${esc(value)}</span><span class="tile-unit">${esc(unit)}</span></div><div class="tile-sub">${esc(sub)}</div></div>`;
  const total = Math.max(1, t.connectors);
  const bars = Object.entries(t.status)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `<div style="width:${((n / total) * 100).toFixed(2)}%;background:${(STATUS[k] ?? STATUS.Unknown).dot}"></div>`)
    .join('');
  const counts = Object.entries(t.status)
    .map(([k, n]) => `<span><span class="dot" style="background:${(STATUS[k] ?? STATUS.Unknown).dot}"></span>${esc(k)} <b>${n}</b></span>`)
    .join('');
  $('tiles').innerHTML =
    tile('Sites in view', t.sites, '', `${t.chargers} chargers · ${t.connectors} connectors · ${t.staleSites} stale · ${t.unresolvedSites} unresolved`) +
    tile('Active faults', t.activeFaults.critical + t.activeFaults.warning, '', `${t.activeFaults.critical} critical · ${t.activeFaults.warning} warning`) +
    tile('Energy settled', fmtNum(kwh, 3), 'kWh', `${charged.length ? `${charged.length} session${charged.length === 1 ? '' : 's'}, one invoice each` : 'No session has passed checks yet'} · ${dups} duplicate stop${dups === 1 ? '' : 's'} blocked`) +
    tile('Held for review', held.length, held.length === 1 ? 'session' : 'sessions', Object.entries(reasons).map(([r, n]) => `${n} ${r.replace(/_/g, ' ')}`).join(' · ') || 'Nothing waiting for review') +
    `<div class="tile status-tile"><div class="tile-label">Connector status</div><div class="bar" aria-hidden="true">${bars}</div><div class="counts">${counts}</div></div>`;
}

function renderSites(status) {
  const sites = status.sites.filter((s) => state.showSynthetic || !s.synthetic);
  const hidden = status.sites.length - sites.length;
  $('sites').innerHTML =
    sites
      .map((s) => {
        const r = ROLLUP[s.rollup];
        const geo = s.geocode.status === 'resolved' ? `${s.geocode.precision} · ${s.geocode.source}` : 'unresolved: not on the map';
        const conns = s.connectors
          .map((c) => {
            const st = STATUS[c.status] ?? STATUS.Unknown;
            const parts = [];
            if (c.statusAt) parts.push(`Since ${fmtLocal(c.statusAt, s.timezone)}`);
            if (c.fault) parts.push(`${c.fault.code} (${c.fault.severity}) at ${fmtLocal(c.fault.at, s.timezone)}`);
            if (c.powerW !== null && c.status === 'Charging') parts.push(`${fmtNum(c.powerW / 1000, 1)} kW`);
            if (!c.statusAt && !c.fault) parts.push('No status event received yet.');
            return `<div class="conn"><div class="conn-head"><span class="mono">${esc(c.chargerId)} · ${esc(c.connectorId)} <span class="muted small">${esc(c.model ?? '')} · ${esc(c.maxKw)} kW</span></span>${pill(c.status, st.fg, st.bg)}</div><div class="small" style="color:var(--ink-2)">${esc(parts.join(' · '))}</div></div>`;
          })
          .join('');
        return `<div class="site"><div class="site-head"><div><div class="site-name">${esc(s.name)} <span class="site-id">${esc(s.siteId)}</span></div><div class="small muted">${esc(s.address)}</div><div class="badges"><span class="badge">Geocode: ${esc(geo)}</span><span class="badge">Last vendor contact ${esc(fmtAge(s.lastContact.ageSec))}${s.lastContact.via ? ' · ' + esc(s.lastContact.via) : ''}</span></div></div>${pill(r.label, r.fg, r.bg)}</div>${conns}</div>`;
      })
      .join('') + (hidden ? `<div class="small muted">${hidden} synthetic site${hidden === 1 ? '' : 's'} hidden.</div>` : '');
}

function initMap() {
  if (state.map || typeof maplibregl === 'undefined') {
    if (typeof maplibregl === 'undefined') $('map').innerHTML = '<div class="map-fallback">Map library could not load (offline?). Everything else on this page still works.</div>';
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
  // The container's width settles after fonts and flex layout; keep the canvas in step.
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
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `<b>${esc(p.name)}</b><br>${esc(ROLLUP[p.rollup]?.label ?? p.rollup)} · ${esc(p.connectorsAvailable)}/${esc(p.connectorsTotal)} available<br>Pin: ${esc(p.geocodePrecision)} (${esc(p.geocodeSource)})<br>Last vendor contact ${esc(fmtAge(p.lastContactAgeSec))}`,
        )
        .addTo(map);
    });
    map.on('click', (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ['sites'] }).length) return;
      state.point = { key: null, name: `${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}`, lat: e.lngLat.lat, lng: e.lngLat.lng };
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
  const counts = {};
  for (const f of geo.features) counts[f.properties.rollup] = (counts[f.properties.rollup] ?? 0) + 1;
  $('legend').innerHTML =
    Object.entries(ROLLUP)
      .map(([k, r]) => `<span><span class="dot" style="background:${r.color}"></span>${esc(r.label)} ${counts[k] ?? 0}</span>`)
      .join('') + `<span>${geo.unresolved.length} without coordinates</span>`;
  if (!state.mapReady) return;
  const features = geo.features.filter((f) => state.showSynthetic || !f.properties.synthetic);
  state.map.getSource('sites').setData({ type: 'FeatureCollection', features });
  if (!state.fitted && features.length) {
    const b = new maplibregl.LngLatBounds();
    for (const f of features) b.extend(f.geometry.coordinates);
    state.map.fitBounds(b, { padding: 60, maxZoom: 12, duration: 0 });
    state.fitted = true;
  }
  state.map.getSource('point').setData({
    type: 'FeatureCollection',
    features: state.point ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [state.point.lng, state.point.lat] }, properties: {} }] : [],
  });
}

async function loadNearest() {
  renderPersonas();
  if (!state.point) {
    $('nearest').innerHTML = '<div class="small muted">Pick a search point, or click anywhere on the map.</div>';
    return;
  }
  const { lat, lng, name } = state.point;
  try {
    const d = await api(`/v1/chargers/nearest?lat=${lat}&lng=${lng}&max_km=50&limit=1`);
    let html = `<div class="k">From ${esc(name)}</div>`;
    if (d.results.length) {
      const r = d.results[0];
      html += `<div><span class="near-name">${esc(r.name)}</span> <span class="mono">${fmtNum(r.distanceKm, 1)} km</span></div><div class="small">Available now: ${esc(r.available.map((a) => `${a.chargerId} · ${a.connectorId}`).join(', '))} · pin precision: ${esc(r.geocodePrecision)}</div>`;
    } else {
      html += `<div class="near-name">No available connector within ${esc(d.maxKm)} km</div><div class="small">${d.nearestBeyondRadius ? `Nearest available in this view: ${esc(d.nearestBeyondRadius.name)}, ${fmtNum(d.nearestBeyondRadius.distanceKm, 0)} km away.` : 'No connector in this view is currently Available. Other tenants are never searched.'}</div>`;
    }
    if (d.skippedCloser.length) {
      html +=
        `<div class="small" style="font-weight:600;padding-top:6px">Closer, but skipped</div>` +
        d.skippedCloser.map((s) => `<div class="skip"><span>${esc(s.name)} <span class="mono muted">${fmtNum(s.distanceKm, 1)} km</span></span><span>${esc(s.reason)}</span></div>`).join('');
    }
    $('nearest').innerHTML = html;
  } catch (err) {
    $('nearest').innerHTML = `<div class="small">${esc(err.message)}</div>`;
  }
  if (state.mapReady) renderMapPointOnly();
}

function renderMapPointOnly() {
  state.map.getSource('point').setData({
    type: 'FeatureCollection',
    features: state.point ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [state.point.lng, state.point.lat] }, properties: {} }] : [],
  });
}

function renderFreshness(f) {
  const VERDICT = {
    missed_at_source: { text: 'Missed before we see it', color: '#B0302A', bar: '#C0362C' },
    ours_met: { text: 'Ours to meet: met', color: '#1D5FD0', bar: 'transparent' },
    ours_at_risk: { text: 'Ours to meet: at risk', color: '#B0302A', bar: 'transparent' },
    ours_no_data: { text: 'Ours to meet', color: '#1D5FD0', bar: 'transparent' },
  };
  const pct = (s) => `${Math.min(100, Math.max(0, s))}%`;
  $('fresh').innerHTML = f.signals
    .map((s) => {
      const v = VERDICT[s.verdict] ?? VERDICT.missed_at_source;
      const a = s.vendorAgeWhenServed;
      const fill = a ? `<div class="fill" style="left:${pct(a.minSec)};width:${pct(Math.max(1, a.maxSec - a.minSec))};background:${v.bar}"></div>` : '';
      const observed = a
        ? `${fmtNum(a.minSec)}–${fmtNum(a.maxSec)} s old when the vendor served it (${a.samples} event${a.samples === 1 ? '' : 's'})`
        : s.verdict.startsWith('ours')
          ? 'Receipt to screen happens inside our stack'
          : 'No poll samples yet';
      return `<div class="fresh-row"><div class="top-line"><b>${esc(s.signal)}</b><span class="muted">Target &lt; ${esc(s.targetSec)} s · ${esc(s.percentile)}</span></div><div class="track" aria-hidden="true">${fill}<div class="tick" style="left:${pct(s.targetSec)}"></div></div><div class="bottom-line"><span style="color:var(--ink-2)">${esc(observed)}</span><b style="color:${v.color}">${esc(v.text)}</b></div><div class="small muted">${esc(s.vendorFloor)}</div></div>`;
    })
    .join('');
  const p = f.platform;
  $('platform').innerHTML = p.events
    ? `GridWatch's own share, receipt → committed state: p50 ${fmtNum(p.p50Sec * 1000)} ms, p99.9 ${fmtNum(p.p999Sec * 1000)} ms over ${fmtNum(p.events)} events. Webhook batches can add up to 60 s before we see anything, so the two parts are measured and reported separately.`
    : 'No events processed yet.';
}

function renderSessions(sessions, statements) {
  $('statements').innerHTML = statements.length
    ? statements
        .map(
          (s) =>
            `<div class="statement"><div class="k">Statement · ${esc(s.operator_id)} · ${esc(s.business_date)} (${esc(s.timezone)}) · v${esc(s.version)}</div><div><b>${esc(s.total_amount)} ${esc(s.currency)}</b> for ${esc(s.session_count)} session${s.session_count === 1 ? '' : 's'}, ${fmtNum(Number(s.energy_wh) / 1000, 3)} kWh · ${esc(s.held_count)} held for review</div></div>`,
        )
        .join('')
    : '<div class="small muted">No settlement statement yet. Run: docker compose exec api node dist/bin/settle.js --date 2026-06-09</div>';
  const TONE = {
    charged: { label: 'Settled once', fg: '#176B5B', bg: '#E1F2EE' },
    needs_review: { label: 'Held for review', fg: '#7A4A00', bg: '#FCF0DC' },
    awaiting_start: { label: 'Waiting for start', fg: '#5A616B', bg: '#ECEEF1' },
    open: { label: 'In progress', fg: '#5B33B3', bg: '#EEE8FA' },
  };
  $('sessions').innerHTML = sessions
    .map((s) => {
      const t = TONE[s.billing_status] ?? TONE.open;
      const energy =
        s.energy_wh !== null
          ? `${fmtNum(Number(s.energy_wh) / 1000, 3)} kWh (${s.energy_method})`
          : s.billing_status === 'needs_review'
            ? 'Not billed: held'
            : 'Not computable yet';
      const reg = s.start_meter_wh !== null ? `${fmtNum(s.start_meter_wh)} → ${s.stop_meter_wh !== null ? fmtNum(s.stop_meter_wh) : '…'} Wh` : '–';
      const amount = s.total_amount ? `${esc(s.total_amount)} ${esc(s.currency)} · business day ${esc(s.business_date)}` : 'Not invoiced';
      const why = s.review_detail ?? (s.billing_status === 'charged' ? `Rated with ${s.tariff_id}: ${s.price_per_kwh}/kWh + ${s.session_fee} fee.` : '');
      return `<div class="session"><div><span class="mono" style="font-weight:600">${esc(s.session_id)}</span><span class="small muted">${esc(s.site_name)} · ${esc(s.charger_id)} · ${esc(s.connector_id)}</span><span>${pill(t.label, t.fg, t.bg)}</span></div><div><span class="k">Start → stop</span><span class="small">${esc(s.started_at ? fmtLocal(s.started_at, s.timezone) : 'No start event received')}</span><span class="small">${esc(s.stopped_at ? fmtLocal(s.stopped_at, s.timezone) : '–')}</span></div><div><span class="k">Energy register</span><span class="mono small">${esc(reg)}</span><b>${esc(energy)}</b></div><div><span class="k">Invoice</span><span class="small">${amount}</span></div><div class="why">${esc(why)}</div></div>`;
    })
    .join('');
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
    $('asof').textContent = `As of ${new Date(status.asOf).toLocaleTimeString()} · ${status.totals.sites} sites · refresh 5 s`;
    renderTiles(status, sessions.sessions, events);
    renderSites(status);
    renderMap(geo);
    renderFreshness(fresh);
    renderSessions(sessions.sessions, statements.statements);
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
  renderPersonas();
  await login(persona);
  await Promise.all([refresh(), loadNearest()]);
}

document.addEventListener('click', (e) => {
  const persona = e.target.closest('[data-persona]');
  if (persona) void switchPersona(persona.dataset.persona);
  const point = e.target.closest('[data-point]');
  if (point) {
    const k = point.dataset.point;
    state.point = { key: k, ...POINTS[k] };
    void loadNearest();
  }
});
$('show-synthetic').checked = state.showSynthetic;
$('show-synthetic').addEventListener('change', (e) => {
  state.showSynthetic = e.target.checked;
  writePref('gw.synthetic', String(state.showSynthetic));
  state.fitted = false;
  void refresh();
});

initMap();
if (!PERSONAS[state.persona]) state.persona = 'acme-charge';
void switchPersona(state.persona);
state.timer = setInterval(() => void refresh(), 5000);
