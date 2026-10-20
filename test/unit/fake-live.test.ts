import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiveSim, type LiveSite } from '../../src/fake-csms/live.js';
import { buildFakeCsms } from '../../src/fake-csms/server.js';
import { repoRoot } from '../helpers/fixtures.js';

// The live simulator must stay inside the vendor's documented behaviour, or
// the demo would look better than the real feed could ever be.

const T0 = Date.parse('2026-10-20T08:00:00Z');
const SITES: LiveSite[] = [
  {
    siteId: 'S-T-1',
    timezone: 'Asia/Kolkata',
    chargers: [
      { chargerId: 'C-T-1-A', maxKw: 60, connectors: ['1', '2'] },
      { chargerId: 'C-T-1-B', maxKw: 22, connectors: ['1'] },
    ],
  },
  { siteId: 'S-T-2', timezone: 'Europe/Berlin', chargers: [{ chargerId: 'C-T-2-A', maxKw: 150, connectors: ['1', '2', '3', '4'] }] },
];
const OPTS = { seed: 7, duplicateRate: 0.2, malformedRate: 0.1, lateRate: 0.02 };
type Ev = { type: string; charger_id: string; connector_id: string; ts: string; energy_register_wh?: number; power_w?: number; event?: string; session_id?: string; start_meter_wh?: number; stop_meter_wh?: number };

// Every event a site has, read the way the poller reads it: since, then cursor pages.
function readAll(sim: LiveSim, siteId: string, since: string, nowMs: number): Ev[] {
  const out: Ev[] = [];
  let page = sim.page(siteId, { since }, nowMs)!;
  out.push(...(page.events as Ev[]));
  while ('next_cursor' in page && page.next_cursor) {
    page = sim.page(siteId, { cursor: page.next_cursor }, nowMs)!;
    out.push(...(page.events as Ev[]));
  }
  return out;
}

describe('live simulator: physics and cadence', () => {
  const sim = new LiveSim(SITES, { ...OPTS, bootMs: T0 });
  const end = T0 + 3 * 3600_000;
  const events = SITES.flatMap((s) => readAll(sim, s.siteId, new Date(T0 - 3600_000).toISOString(), end));
  const maxKw = new Map(SITES.flatMap((s) => s.chargers.map((c) => [c.chargerId, c.maxKw])));

  it('produces sessions, readings and faults', () => {
    expect(events.filter((e) => e.event === 'session.stop').length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'meter_value').length).toBeGreaterThan(100);
  });

  it('never lets a lifetime register fall, nor power exceed the charger', () => {
    const byConn = new Map<string, Ev[]>();
    for (const e of events.filter((x) => x.type === 'meter_value')) byConn.set(`${e.charger_id}/${e.connector_id}`, [...(byConn.get(`${e.charger_id}/${e.connector_id}`) ?? []), e]);
    for (const list of byConn.values()) {
      list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      for (let i = 1; i < list.length; i++) expect(list[i]!.energy_register_wh!).toBeGreaterThanOrEqual(list[i - 1]!.energy_register_wh!);
      for (const e of list) expect(e.power_w!).toBeLessThanOrEqual(maxKw.get(e.charger_id)! * 1000);
    }
  });

  it('reads every 10 s while charging, and bills plausibly', () => {
    for (const stop of events.filter((e) => e.event === 'session.stop')) {
      const start = events.find((e) => e.event === 'session.start' && e.session_id === stop.session_id);
      if (!start) continue; // started before the window
      const t0 = Date.parse(start.ts);
      const t1 = Date.parse(stop.ts);
      const readings = events
        .filter((e) => e.type === 'meter_value' && e.charger_id === stop.charger_id && e.connector_id === stop.connector_id && Date.parse(e.ts) > t0 && Date.parse(e.ts) <= t1)
        .map((e) => Date.parse(e.ts))
        .sort((a, b) => a - b);
      for (let i = 1; i < readings.length; i++) expect(readings[i]! - readings[i - 1]!).toBe(10_000);
      const energy = stop.stop_meter_wh! - stop.start_meter_wh!;
      expect(energy).toBeGreaterThan(0);
      expect(energy).toBeLessThanOrEqual(maxKw.get(stop.charger_id)! * 1000 * ((t1 - t0) / 3_600_000) * 1.1);
    }
  });

  it('never back-dates anything, so a restart cannot rewrite served history', () => {
    expect(events.every((e) => Date.parse(e.ts) >= T0)).toBe(true);
  });

  it('is the same however often it is advanced', () => {
    const a = new LiveSim(SITES, { ...OPTS, bootMs: T0 });
    const b = new LiveSim(SITES, { ...OPTS, bootMs: T0 });
    for (let t = T0; t <= T0 + 3600_000; t += 37_000) b.advanceTo(t);
    const since = new Date(T0 - 3600_000).toISOString();
    expect(readAll(a, 'S-T-2', since, T0 + 3600_000)).toEqual(readAll(b, 'S-T-2', since, T0 + 3600_000));
  });
});

describe('live simulator: the vendor contract', () => {
  it('honours since, and keeps a paginated cycle on one window', () => {
    const sim = new LiveSim(SITES, { ...OPTS, bootMs: T0 });
    const since = new Date(T0 + 1800_000).toISOString();
    const page = sim.page('S-T-2', { since }, T0 + 3600_000)!;
    expect((page.events as Ev[]).every((e) => Date.parse(e.ts) >= Date.parse(since))).toBe(true);
    const all = readAll(sim, 'S-T-2', new Date(T0 - 3600_000).toISOString(), T0 + 3600_000);
    const keys = all.map((e) => `${e.charger_id}/${e.connector_id}/${e.ts}/${e.type}/${e.event ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length); // each event exactly once across pages
    // A cursor taken earlier still reads its own window, not newer events.
    const first = sim.page('S-T-2', { since: new Date(T0 - 3600_000).toISOString() }, T0 + 3600_000)!;
    const later = sim.page('S-T-2', { cursor: first.next_cursor! }, T0 + 7200_000)!;
    expect((later.events as Ev[]).every((e) => Date.parse(e.ts) <= T0 + 3600_000)).toBe(true);
  });

  it('sends status, sessions and faults by webhook, never meter values, held 5-60 s', () => {
    const sim = new LiveSim(SITES, { ...OPTS, duplicateRate: 0.5, malformedRate: 0.5, bootMs: T0 });
    sim.startWebhooks(T0);
    const batches = [];
    for (let t = T0; t <= T0 + 2 * 3600_000; t += 1000) batches.push(...sim.dueBatches(t));
    expect(batches.length).toBeGreaterThan(0);
    for (const b of batches) {
      const evs = b.body.events as Ev[];
      expect(evs.some((e) => e.type === 'meter_value')).toBe(false);
      if (b.duplicate) continue;
      const ts = evs.map((e) => Date.parse(e.ts));
      expect(b.deliverAtMs - Math.min(...ts)).toBeLessThanOrEqual(60_000);
      expect(b.deliverAtMs - Math.max(...ts)).toBeGreaterThanOrEqual(5_000);
    }
    expect(batches.some((b) => b.duplicate)).toBe(true);
    expect(batches.some((b) => (b.body.events as Ev[]).some((e) => e.type === 'status' && !('status' in e)))).toBe(true); // a broken one
  });
});

describe('fake vendor with live mode', () => {
  const build = (live: boolean, minIntervalSec = 0) =>
    buildFakeCsms({
      fixturesDir: path.join(repoRoot, 'fixtures/stubs'),
      seedDir: path.join(repoRoot, 'seed'),
      webhookUrl: null,
      webhookSecret: 'x',
      errorRate: 0,
      minIntervalSec,
      live: live ? OPTS : null,
    }).app;

  it('serves the pilot sites exactly the same with live mode on or off', async () => {
    const script = ['site_id=S-IN-0007', 'site_id=S-IN-0007&cursor=eyJvZmZzZXQiOjUwfQ==', 'site_id=S-DE-0003', 'site_id=S-DE-0003', 'site_id=S-IN-0007'];
    const run = async (live: boolean) => {
      const app = build(live);
      const out = [];
      for (const q of script) {
        const r = await app.inject({ method: 'GET', url: `/v1/chargers?${q}` });
        out.push({ status: r.statusCode, body: r.body });
      }
      await app.close();
      return out;
    };
    const [on, off] = [await run(true), await run(false)];
    expect(on.map((r) => r.status)).toEqual([200, 200, 500, 200, 429]);
    expect(on).toEqual(off);
  });

  it('rate-limits a live site polled again within 30 s', async () => {
    const app = build(true, 30);
    expect((await app.inject({ method: 'GET', url: '/v1/chargers?site_id=S-IN-0005' })).statusCode).toBe(200);
    const again = await app.inject({ method: 'GET', url: '/v1/chargers?site_id=S-IN-0005' });
    expect(again.statusCode).toBe(429);
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });
});
