#!/usr/bin/env node
// Generates seed/synthetic-pilot.json: a deterministic expansion of the 3-site
// pilot excerpt to the 50-site / 220-charger pilot the brief describes. The
// brief mentions a "starter kit" with the full set, but none was provided.
// Every generated site is marked synthetic. Run: node scripts/generate-synthetic-pilot.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const pilot = JSON.parse(readFileSync(new URL('../seed/pilot-sample-data.json', import.meta.url), 'utf8'));

// mulberry32: tiny seeded PRNG so the output never changes between runs.
function prng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(42);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const IN_AREAS = [
  ['110001', 'Connaught Place', 'New Delhi', 'DL'],
  ['110017', 'Saket', 'New Delhi', 'DL'],
  ['122002', 'DLF Phase 2', 'Gurugram', 'HR'],
  ['201301', 'Sector 18', 'Noida', 'UP'],
  ['560001', 'MG Road', 'Bengaluru', 'KA'],
  ['560034', 'Koramangala', 'Bengaluru', 'KA'],
  ['560048', 'Mahadevapura', 'Bengaluru', 'KA'],
  ['560066', 'Whitefield', 'Bengaluru', 'KA'],
  ['400001', 'Fort', 'Mumbai', 'MH'],
  ['400051', 'Bandra East', 'Mumbai', 'MH'],
  ['411001', 'Camp', 'Pune', 'MH'],
];
const DE_AREAS = [
  ['70173', 'Mitte', 'Stuttgart'],
  ['70174', 'Nord', 'Stuttgart'],
  ['70176', 'West', 'Stuttgart'],
  ['70178', 'Süd', 'Stuttgart'],
  ['70190', 'Ost', 'Stuttgart'],
  ['70372', 'Bad Cannstatt', 'Stuttgart'],
  ['70565', 'Vaihingen', 'Stuttgart'],
  ['71032', 'Zentrum', 'Böblingen'],
  ['71634', 'Innenstadt', 'Ludwigsburg'],
  ['73728', 'Altstadt', 'Esslingen am Neckar'],
];
const IN_MODELS = [
  { model: 'DeltaDC-60', max_kw: 60, connectors: ['1', '2'] },
  { model: 'ABB-Terra-AC', max_kw: 22, connectors: ['1'] },
];
const DE_MODELS = [
  { model: 'Alpitronic-HYC', max_kw: 150, connectors: ['1', '2'] },
  { model: 'ABB-Terra-AC', max_kw: 22, connectors: ['1'] },
];

const TOTAL_SITES = 50;
const TOTAL_CHARGERS = 220;
const IN_SYNTHETIC = 28; // + 2 real Acme sites = 30
const DE_SYNTHETIC = 19; // + 1 real Stadtwerke site = 20

const realIds = new Set(pilot.sites.map((s) => s.site_id));
const sites = [];
function nextId(prefix, start) {
  let n = start;
  return () => {
    for (;;) {
      n += 1;
      const id = `${prefix}-${String(n).padStart(4, '0')}`;
      if (!realIds.has(id)) return id;
    }
  };
}
const inId = nextId('S-IN', 0);
const deId = nextId('S-DE', 0);

for (let i = 0; i < IN_SYNTHETIC; i++) {
  const id = inId();
  if (i === IN_SYNTHETIC - 1) {
    // Deliberately unresolvable: no PIN code, so it stays off the map.
    sites.push({ site_id: id, operator_id: 'acme-charge', name: 'Highway Depot (synthetic)', address: 'Near old bus depot, NH-48 service road', country: 'IN' });
    continue;
  }
  const plot = 10 + Math.floor(rand() * 80);
  if (i === IN_SYNTHETIC - 2) {
    // Deliberately unresolvable the other way: a real PIN (Chennai) that our
    // postal-code list doesn't cover, so it stays off the map with that reason.
    sites.push({ site_id: id, operator_id: 'acme-charge', name: 'Anna Salai Hub (synthetic)', address: `Plot ${plot}, Anna Salai, Chennai, TN 600002`, country: 'IN' });
    continue;
  }
  const [pin, area, city, state] = IN_AREAS[i % IN_AREAS.length];
  sites.push({
    site_id: id,
    operator_id: 'acme-charge',
    name: `${area} Hub ${Math.floor(i / IN_AREAS.length) + 1} (synthetic)`,
    address: `Plot ${plot}, ${area}, ${city}, ${state} ${pin}`,
    country: 'IN',
  });
}
for (let i = 0; i < DE_SYNTHETIC; i++) {
  const id = deId();
  if (i === DE_SYNTHETIC - 1) {
    sites.push({ site_id: id, operator_id: 'stadtwerke-ev', name: 'Waldparkplatz (synthetic)', address: 'Parkplatz am Waldrand, Zufahrt über Feldweg', country: 'DE' });
    continue;
  }
  const [plz, area, city] = DE_AREAS[i % DE_AREAS.length];
  sites.push({
    site_id: id,
    operator_id: 'stadtwerke-ev',
    name: `Ladepark ${city} ${area} ${Math.floor(i / DE_AREAS.length) + 1} (synthetic)`,
    address: `Ladepark ${area}, Musterstraße ${1 + Math.floor(rand() * 120)}, ${plz} ${city}`,
    country: 'DE',
  });
}

// Charger counts: 3-6 per site, then nudged so the pilot totals exactly 220.
const counts = sites.map(() => 3 + Math.floor(rand() * 4));
const target = TOTAL_CHARGERS - pilot.chargers.length;
let diff = target - counts.reduce((a, b) => a + b, 0);
for (let i = 0; diff !== 0; i = (i + 1) % counts.length) {
  if (diff > 0 && counts[i] < 8) {
    counts[i] += 1;
    diff -= 1;
  } else if (diff < 0 && counts[i] > 2) {
    counts[i] -= 1;
    diff += 1;
  }
}

const chargers = [];
sites.forEach((s, i) => {
  const models = s.country === 'IN' ? IN_MODELS : DE_MODELS;
  for (let k = 0; k < counts[i]; k++) {
    const m = pick(models);
    chargers.push({
      charger_id: `C-${s.site_id.slice(2)}-${String.fromCharCode(65 + k)}`,
      site_id: s.site_id,
      model: m.model,
      max_kw: m.max_kw,
      connectors: m.connectors,
    });
  }
});

if (sites.length + pilot.sites.length !== TOTAL_SITES) throw new Error('site count mismatch');
if (chargers.length + pilot.chargers.length !== TOTAL_CHARGERS) throw new Error('charger count mismatch');

writeFileSync(
  new URL('../seed/synthetic-pilot.json', import.meta.url),
  JSON.stringify(
    {
      _note:
        'SYNTHETIC. Deterministic expansion of the 3-site pilot excerpt to the 50-site / 220-charger pilot size, generated by scripts/generate-synthetic-pilot.mjs. Addresses are invented around real postal codes and carry no coordinates. Three are unresolvable on purpose: two have no postal code, one has a postal code outside the postal-code list.',
      sites,
      chargers,
    },
    null,
    2,
  ) + '\n',
);
console.log(`wrote ${sites.length} synthetic sites, ${chargers.length} synthetic chargers`);
