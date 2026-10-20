import { formatOffsetIso } from '../util/time.js';
import { hash01, hashSeed, mulberry32 } from './rng.js';

// A live network for the generated (synthetic) sites, inside the vendor's
// documented behaviour so the demo can't look better than the real feed:
//
// - Every charging connector takes a meter reading every 10 s. Readings are
//   only ever served by poll, never by webhook.
// - Status, session and fault events go by poll AND by webhook. Webhooks are
//   batched by event time into 15 s windows and held a further 5-45 s, so a
//   batch is never more than 60 s old; events inside a batch are shuffled,
//   some batches are delivered twice, and a few carry a broken event.
// - A small share of events only appear at the vendor 2-5 minutes late and
//   skip the webhook, so the poller's hourly reconciliation has work to do.
// - Polls honour `since` and paginate with a stateless cursor.
//
// The simulation is lazy and deterministic: advanceTo(now) plays every 10 s
// tick up to now from a seed, so a test can drive it with a fake clock.

export interface LiveSite {
  siteId: string;
  timezone: string;
  chargers: { chargerId: string; maxKw: number; connectors: string[] }[];
}

export interface LiveOptions {
  seed: number;
  bootMs: number;
  duplicateRate: number; // share of webhook batches delivered twice
  malformedRate: number; // share of webhook batches with one broken event
  lateRate: number; // share of events the vendor exposes 2-5 min late
}

export interface LiveBatch {
  deliveryId: string;
  deliverAtMs: number;
  body: { delivery_id: string; events: unknown[] };
  duplicate: boolean;
}

interface LogEvent {
  seq: number;
  tsMs: number;
  visibleMs: number;
  webhook: boolean;
  body: Record<string, unknown>;
}

type State = 'Available' | 'Charging' | 'Faulted';

interface Conn {
  siteId: string;
  tz: string;
  chargerId: string;
  connectorId: string;
  maxKw: number;
  state: State;
  registerWh: number;
  session: { id: string; startWh: number; startMs: number; targetW: number } | null;
  nextTickMs: number;
  rng: () => number;
}

const TICK_MS = 10_000;
const WINDOW_MS = 15_000;
const PAGE_SIZE = 200;
const KEEP_MS = 3 * 3600_000; // longer than the poller's 2 h reconciliation window
const MIN_SESSION_MS = 5 * 60_000;
// Per-tick odds. Steady state: about 15% of connectors charging, sessions
// around 30 minutes, a fault every couple of days per connector.
const P_START = 0.0011;
const P_STOP = 0.0055;
const P_FAULT = 0.00006;
const P_RECOVER = 0.008;
const EPOCH_MS = Date.UTC(2026, 0, 1);

export class LiveSim {
  readonly bootId: string;
  readonly stats = { events: 0, sessionsStarted: 0, sessionsStopped: 0, faults: 0, batches: 0, duplicates: 0, malformed: 0, late: 0 };
  private readonly conns: Conn[] = [];
  private readonly logs = new Map<string, LogEvent[]>();
  private readonly windows = new Map<number, LogEvent[]>();
  private readonly pendingDuplicates: LiveBatch[] = [];
  private seq = 0;
  private sessionN = 0;
  private webhooksFromMs: number | null = null;
  private lastPruneMs = 0;

  constructor(
    sites: LiveSite[],
    private readonly o: LiveOptions,
  ) {
    this.bootId = Math.floor(o.bootMs / 1000).toString(36);
    for (const site of sites) {
      this.logs.set(site.siteId, []);
      for (const ch of site.chargers) {
        for (const connectorId of ch.connectors) {
          const id = `${ch.chargerId}/${connectorId}`;
          // Lifetime registers grow with calendar time from a per-connector
          // base, faster than any session could add, so a restart of this
          // fake never looks like a meter reset.
          const registerWh = 5_000_000 + Math.floor(hash01(`${id}/base`) * 4_000_000) + Math.floor(((o.bootMs - EPOCH_MS) / 1000) * ch.maxKw * 0.06);
          this.conns.push({
            siteId: site.siteId,
            tz: site.timezone,
            chargerId: ch.chargerId,
            connectorId,
            maxKw: ch.maxKw,
            state: 'Available',
            registerWh,
            session: null,
            nextTickMs: o.bootMs + Math.floor(hash01(`${id}/phase`) * TICK_MS),
            rng: mulberry32(hashSeed(o.seed, id)),
          });
        }
      }
    }
    for (const c of this.conns) this.initial(c);
  }

  // Webhooks start once the scripted stub scenario has finished, so the
  // pilot sites' deliveries stay exactly as the stubs describe.
  startWebhooks(nowMs: number): void {
    this.webhooksFromMs ??= nowMs;
  }

  advanceTo(nowMs: number): void {
    for (const c of this.conns) {
      while (c.nextTickMs <= nowMs) {
        this.step(c, c.nextTickMs);
        c.nextTickMs += TICK_MS;
      }
    }
    if (nowMs - this.lastPruneMs > 5 * 60_000) {
      this.lastPruneMs = nowMs;
      for (const [siteId, log] of this.logs) this.logs.set(siteId, log.filter((e) => e.tsMs >= nowMs - KEEP_MS));
      // Windows nobody collected (webhooks off) are dropped after 10 minutes.
      for (const k of this.windows.keys()) if ((k + 1) * WINDOW_MS < nowMs - 10 * 60_000) this.windows.delete(k);
    }
  }

  // GET /v1/chargers for a live site. The first page fixes the window (since,
  // now]; the cursor carries it, so a resumed cycle (after a 429, say) reads
  // the same window even though new events keep arriving.
  page(siteId: string, q: { since?: string; cursor?: string }, nowMs: number) {
    this.advanceTo(nowMs);
    const log = this.logs.get(siteId) ?? [];
    let win: { s: number; u: number; o: number };
    if (q.cursor) {
      try {
        win = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (![win.s, win.u, win.o].every(Number.isFinite)) return null;
    } else {
      const since = q.since ? Date.parse(q.since) : NaN;
      win = { s: Number.isFinite(since) ? since : nowMs - 86_400_000, u: nowMs, o: 0 };
    }
    const all = log.filter((e) => e.tsMs >= win.s && e.tsMs <= win.u && e.visibleMs <= win.u).sort((a, b) => a.tsMs - b.tsMs || a.seq - b.seq);
    const slice = all.slice(win.o, win.o + PAGE_SIZE);
    const more = win.o + PAGE_SIZE < all.length;
    const tz = this.conns.find((c) => c.siteId === siteId)?.tz ?? 'UTC';
    return {
      site_id: siteId,
      server_time: formatOffsetIso(new Date(win.u), tz),
      events: slice.map((e) => e.body),
      ...(more ? { next_cursor: Buffer.from(JSON.stringify({ ...win, o: win.o + PAGE_SIZE })).toString('base64url') } : {}),
    };
  }

  // Every random choice outside a connector's own ticks hashes from what it
  // is about, so the run is the same however often advanceTo is called.
  private chance(...parts: (string | number)[]): number {
    return hash01([this.o.seed, ...parts].join('/'));
  }

  // Webhook batches whose hold has expired, oldest first.
  dueBatches(nowMs: number): LiveBatch[] {
    this.advanceTo(nowMs);
    const out: LiveBatch[] = [];
    for (const [k, events] of [...this.windows.entries()].sort((a, b) => a[0] - b[0])) {
      const deliverAtMs = (k + 1) * WINDOW_MS + 5_000 + Math.floor(this.chance('hold', k) * 40_000);
      if (deliverAtMs > nowMs) continue;
      this.windows.delete(k);
      if (this.webhooksFromMs === null || k * WINDOW_MS < this.webhooksFromMs) continue;
      const body = events.map((e) => e.body);
      const shuffle = mulberry32(hashSeed(this.o.seed, 'shuffle', k));
      for (let i = body.length - 1; i > 0; i--) {
        const j = Math.floor(shuffle() * (i + 1));
        [body[i], body[j]] = [body[j]!, body[i]!];
      }
      if (this.chance('malformed', k) < this.o.malformedRate && events[0]) {
        // A status with no status: the receiver must set it aside on its own.
        body.push({ type: 'status', charger_id: events[0].body.charger_id, ts: events[0].body.ts });
        this.stats.malformed++;
      }
      const deliveryId = `dlv-live-${this.bootId}-${k}`;
      const batch: LiveBatch = { deliveryId, deliverAtMs, body: { delivery_id: deliveryId, events: body }, duplicate: false };
      out.push(batch);
      this.stats.batches++;
      if (this.chance('duplicate', k) < this.o.duplicateRate) {
        this.pendingDuplicates.push({ ...batch, deliverAtMs: deliverAtMs + 10_000 + Math.floor(this.chance('redeliver', k) * 30_000), duplicate: true });
      }
    }
    for (let i = this.pendingDuplicates.length - 1; i >= 0; i--) {
      if (this.pendingDuplicates[i]!.deliverAtMs <= nowMs) {
        out.push(this.pendingDuplicates.splice(i, 1)[0]!);
        this.stats.duplicates++;
      }
    }
    return out.sort((a, b) => a.deliverAtMs - b.deliverAtMs);
  }

  // The state at start-up, reported at the boot time itself. Nothing is
  // back-dated: if this fake restarts, history it already served must not be
  // rewritten with different values (a real vendor's history doesn't change).
  private initial(c: Conn): void {
    const u = c.rng();
    const boot = this.o.bootMs;
    if (u < 0.15) this.startSession(c, boot);
    else if (u < 0.18) this.fault(c, boot);
    else this.emit(c, boot, { type: 'status', status: 'Available' });
  }

  private step(c: Conn, t: number): void {
    const r = c.rng();
    if (c.state === 'Charging') {
      this.reading(c, t);
      if (t - c.session!.startMs >= MIN_SESSION_MS && r < P_STOP) this.stopSession(c, t);
    } else if (c.state === 'Available') {
      if (r < P_START) this.startSession(c, t);
      else if (r < P_START + P_FAULT) this.fault(c, t);
    } else if (r < P_RECOVER) {
      c.state = 'Available';
      this.emit(c, t, { type: 'status', status: 'Available' });
    }
  }

  private startSession(c: Conn, t: number): void {
    const id = `sess-live-${this.bootId}-${++this.sessionN}`;
    // What the car will take: 45-90% of the charger's rating.
    c.session = { id, startWh: c.registerWh, startMs: t, targetW: c.maxKw * 1000 * (0.45 + 0.45 * c.rng()) };
    c.state = 'Charging';
    this.stats.sessionsStarted++;
    this.emit(c, t, { type: 'status', status: 'Charging' });
    this.emit(c, t, { type: 'session', event: 'session.start', session_id: id, start_meter_wh: c.registerWh });
  }

  private reading(c: Conn, t: number): void {
    const powerW = Math.min(c.maxKw * 1000 * 0.95, Math.round(c.session!.targetW * (0.95 + 0.05 * c.rng())));
    c.registerWh += Math.round((powerW * TICK_MS) / 3_600_000);
    this.emit(c, t, { type: 'meter_value', energy_register_wh: c.registerWh, power_w: powerW });
  }

  private stopSession(c: Conn, t: number): void {
    const s = c.session!;
    this.emit(c, t, { type: 'session', event: 'session.stop', session_id: s.id, start_meter_wh: s.startWh, stop_meter_wh: c.registerWh });
    this.emit(c, t, { type: 'status', status: 'Available' });
    c.session = null;
    c.state = 'Available';
    this.stats.sessionsStopped++;
  }

  private fault(c: Conn, t: number): void {
    c.state = 'Faulted';
    this.stats.faults++;
    this.emit(c, t, { type: 'fault', code: 'InternalError', severity: 'critical' });
    this.emit(c, t, { type: 'status', status: 'Faulted' });
  }

  private emit(c: Conn, tsMs: number, fields: Record<string, unknown>): void {
    const body = { ...fields, charger_id: c.chargerId, connector_id: c.connectorId, ts: formatOffsetIso(new Date(tsMs), c.tz) };
    const id = `${c.chargerId}/${c.connectorId}/${tsMs}/${String(fields.type)}/${String(fields.event ?? fields.status ?? '')}`;
    const late = this.chance('late', id) < this.o.lateRate;
    const isMeter = fields.type === 'meter_value';
    const e: LogEvent = {
      seq: ++this.seq,
      tsMs,
      visibleMs: late ? tsMs + 120_000 + Math.floor(this.chance('lateBy', id) * 180_000) : tsMs,
      webhook: !isMeter && !late,
      body,
    };
    if (late) this.stats.late++;
    this.stats.events++;
    this.logs.get(c.siteId)!.push(e);
    if (e.webhook) {
      const k = Math.floor(tsMs / WINDOW_MS);
      const w = this.windows.get(k);
      if (w) w.push(e);
      else this.windows.set(k, [e]);
    }
  }
}
