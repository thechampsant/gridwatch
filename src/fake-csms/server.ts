import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { signBody } from '../csms/signature.js';
import { formatOffsetIso } from '../util/time.js';
import { LiveSim, type LiveBatch, type LiveOptions } from './live.js';

// A trivial stand-in for the vendor CSMS, built only from the stub payloads
// and the pilot catalogue. It is not part of GridWatch. It replays the stub
// cases in a fixed script so the demo is deterministic:
//
//   S-IN-0007  poll #1 -> stub 1a (has next_cursor) -> cursor -> stub 1b
//              poll #2 -> 429 (scripted: the vendor's quota is shared, so a
//                         well-behaved client can still be throttled)
//   S-DE-0003  poll #1 -> 500 (stub 1d), retry -> stub 1e (malformed events)
//   webhooks   dlv-001..dlv-004 (stubs 2a-2d, incl. the duplicate and the
//              out-of-order batch), signed, redelivered until acknowledged
//   S-IN-0012  after the webhooks -> GroundFailure fault from the pilot sample
//   synthetic  poll #1 -> a deterministic status snapshot for every connector
//              (or, in live mode, a live network: see live.ts)
//   any site   polled again within 30 s -> real 429 with Retry-After
//
// Afterwards every pilot poll returns an empty page with the current
// server_time. Live mode never touches the three pilot sites, so the stub
// scenario plays out exactly the same with it on or off.

export interface FakeOptions {
  fixturesDir: string;
  seedDir: string;
  webhookUrl: string | null;
  webhookSecret: string;
  errorRate: number; // random 500s on generated sites only; the pilot sites stay scripted
  minIntervalSec: number;
  live?: Omit<LiveOptions, 'bootMs'> | null;
  logger?: boolean;
  now?: () => number; // for tests
}

interface SiteMeta {
  siteId: string;
  timezone: string;
  synthetic: boolean;
  chargers: { chargerId: string; maxKw: number; connectors: string[] }[];
}

const TZ: Record<string, string> = { IN: 'Asia/Kolkata', DE: 'Europe/Berlin' };
const STUB_CURSOR = 'eyJvZmZzZXQiOjUwfQ==';

function hash01(s: string): number {
  return createHash('sha256').update(s).digest().readUInt32BE(0) / 2 ** 32;
}

const MAX_QUEUED_BATCHES = 200;
const MAX_IN_FLIGHT = 4;

export function buildFakeCsms(o: FakeOptions) {
  const fixture = (name: string) => JSON.parse(readFileSync(path.join(o.fixturesDir, name), 'utf8'));
  const pilot = JSON.parse(readFileSync(path.join(o.seedDir, 'pilot-sample-data.json'), 'utf8'));
  const synthetic = JSON.parse(readFileSync(path.join(o.seedDir, 'synthetic-pilot.json'), 'utf8'));

  const sites = new Map<string, SiteMeta>();
  for (const [list, isSynthetic] of [[pilot.sites, false], [synthetic.sites, true]] as const) {
    for (const s of list) {
      sites.set(s.site_id, { siteId: s.site_id, timezone: TZ[s.country] ?? 'UTC', synthetic: isSynthetic, chargers: [] });
    }
  }
  for (const ch of [...pilot.chargers, ...synthetic.chargers]) {
    sites.get(ch.site_id)?.chargers.push({ chargerId: ch.charger_id, maxKw: ch.max_kw, connectors: ch.connectors });
  }

  const clock = o.now ?? (() => Date.now());
  const live = o.live
    ? new LiveSim(
        [...sites.values()].filter((s) => s.synthetic),
        { ...o.live, bootMs: clock() },
      )
    : null;

  const lastPoll = new Map<string, number>();
  const polls = new Map<string, number>();
  const script = { s7Page2Served: false, de1eServed: false, webhooksDone: false, s12FaultServed: false, s7PolledAfter429: false };

  const app: FastifyInstance = Fastify({ logger: o.logger ?? false });
  app.get('/healthz', async () => ({ ok: true, script, live: live ? { bootId: live.bootId, ...live.stats } : null }));

  app.get('/v1/chargers', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const site = q.site_id ? sites.get(q.site_id) : undefined;
    if (!site) return reply.code(q.site_id ? 404 : 400).send({ error: 'unknown or missing site_id' });
    const now = new Date(clock());
    const serverTime = formatOffsetIso(now, site.timezone);
    const empty = () => ({ site_id: site.siteId, server_time: serverTime, events: [] as unknown[] });

    // Pagination: cursor requests continue the current poll and aren't rate limited.
    if (q.cursor) {
      if (site.synthetic && live) return live.page(site.siteId, { cursor: q.cursor }, now.getTime()) ?? reply.code(400).send({ error: 'bad cursor' });
      if (site.siteId === 'S-IN-0007' && q.cursor === STUB_CURSOR) {
        script.s7Page2Served = true;
        return fixture('1b-poll-page2-final.json');
      }
      return empty();
    }

    const last = lastPoll.get(site.siteId);
    if (last !== undefined && now.getTime() - last < o.minIntervalSec * 1000) {
      const wait = Math.ceil((o.minIntervalSec * 1000 - (now.getTime() - last)) / 1000);
      reply.header('retry-after', String(wait));
      return reply.code(429).send({ error: 'rate_limited', retry_after_seconds: wait });
    }

    // Random failures only on generated sites, and before the scripted poll
    // counter, so they can never knock the pilot scenario off its script.
    if (site.synthetic && o.errorRate > 0 && Math.random() < o.errorRate) {
      return reply.code(500).send({ error: 'internal', request_id: `req-${Math.random().toString(16).slice(2, 8)}` });
    }
    if (site.synthetic && live) {
      lastPoll.set(site.siteId, now.getTime());
      return live.page(site.siteId, { since: q.since }, now.getTime());
    }

    const n = (polls.get(site.siteId) ?? 0) + 1;
    polls.set(site.siteId, n);

    // Scripted failures don't count as a poll for rate limiting.
    if (site.siteId === 'S-DE-0003' && n === 1) return reply.code(500).send(fixture('1d-server-error.json'));
    if (site.siteId === 'S-IN-0007' && n === 2) {
      reply.header('retry-after', '30');
      return reply.code(429).send(fixture('1c-rate-limited.json'));
    }
    lastPoll.set(site.siteId, now.getTime());
    if (site.siteId === 'S-IN-0007' && n === 1) return fixture('1a-poll-page1.json');
    if (site.siteId === 'S-IN-0007' && n >= 3) script.s7PolledAfter429 = true;
    if (site.siteId === 'S-DE-0003' && n === 2) {
      script.de1eServed = true;
      return fixture('1e-malformed-page.json');
    }
    if (site.siteId === 'S-IN-0012' && script.webhooksDone && !script.s12FaultServed) {
      script.s12FaultServed = true;
      const { _note: _ignored, ...page } = fixture('pilot-S-IN-0012-fault-page.json');
      return page;
    }
    if (site.synthetic && n === 1) return { ...empty(), events: snapshot(site, now) };
    return empty();
  });

  async function deliver(payload: unknown): Promise<void> {
    const body = JSON.stringify(payload);
    const signature = signBody(body, o.webhookSecret);
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(o.webhookUrl!, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csms-signature': signature },
          body,
        });
        if (res.ok) return;
        app.log.warn(`webhook got ${res.status}; redelivering the whole batch`);
      } catch (err) {
        app.log.warn(`webhook delivery failed: ${(err as Error).message}; redelivering`);
      }
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))));
    }
  }

  async function runWebhookScript(): Promise<void> {
    if (!o.webhookUrl) return;
    const deadline = Date.now() + 90_000;
    while (!(script.s7Page2Served && script.de1eServed) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    for (const f of ['2a-webhook-normal.json', '2b-webhook-duplicate.json', '2c-webhook-out-of-order.json', '2d-webhook-meter-reset.json']) {
      await deliver(fixture(f));
    }
    script.webhooksDone = true;
    startLiveWebhooks();
  }

  // Live webhooks are best effort, as the vendor's are: a few retries, then
  // the batch is dropped (the poll still carries every event). Capped, so a
  // receiver outage can't grow memory without bound.
  const queue: LiveBatch[] = [];
  let inFlight = 0;
  let timer: NodeJS.Timeout | null = null;
  function startLiveWebhooks(): void {
    if (!live || !o.webhookUrl || timer) return;
    live.startWebhooks(clock());
    timer = setInterval(() => {
      queue.push(...live.dueBatches(clock()));
      while (queue.length > MAX_QUEUED_BATCHES) app.log.warn(`dropping live batch ${queue.shift()!.deliveryId}: receiver is behind`);
      while (inFlight < MAX_IN_FLIGHT && queue.length) {
        const b = queue.shift()!;
        inFlight++;
        void deliverBestEffort(b).finally(() => inFlight--);
      }
    }, 1000);
  }
  async function deliverBestEffort(b: LiveBatch): Promise<void> {
    const body = JSON.stringify(b.body);
    const signature = signBody(body, o.webhookSecret);
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const res = await fetch(o.webhookUrl!, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csms-signature': signature }, body });
        if (res.ok) return;
      } catch {
        /* retried below */
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    app.log.warn(`gave up on live batch ${b.deliveryId}`);
  }
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });

  return { app, runWebhookScript, script, live };
}

// Deterministic "current status" for a synthetic site's connectors, so the map
// has something to show. Mostly Available, some Charging, a few faulted.
function snapshot(site: SiteMeta, now: Date): unknown[] {
  const events: unknown[] = [];
  for (const ch of site.chargers) {
    for (const conn of ch.connectors) {
      const h = hash01(`${ch.chargerId}/${conn}`);
      const ageSec = Math.floor(hash01(`${ch.chargerId}/${conn}/age`) * 240);
      const ts = formatOffsetIso(new Date(now.getTime() - ageSec * 1000), site.timezone);
      const status = h < 0.6 ? 'Available' : h < 0.82 ? 'Charging' : h < 0.88 ? 'Faulted' : h < 0.94 ? 'Unavailable' : 'SuspendedEV';
      events.push({ type: 'status', charger_id: ch.chargerId, connector_id: conn, status, ts });
      if (status === 'Charging') {
        const power = Math.round(ch.maxKw * 1000 * (0.4 + 0.5 * hash01(`${ch.chargerId}/${conn}/p`)));
        const register = 1_000_000 + Math.floor(hash01(`${ch.chargerId}/${conn}/e`) * 9_000_000);
        events.push({ type: 'meter_value', charger_id: ch.chargerId, connector_id: conn, energy_register_wh: register, power_w: power, ts });
      }
      if (status === 'Faulted') {
        events.push({ type: 'fault', charger_id: ch.chargerId, connector_id: conn, code: 'InternalError', severity: 'critical', ts });
      }
    }
  }
  return events;
}
