import pg from 'pg';
import { CHANGES_CHANNEL, type Change } from '../db/changes.js';
import type { TenantContext } from '../db/pool.js';
import { metrics } from '../observability/metrics.js';

// Push to dashboards (Part A §7.3), slice version: one LISTEN connection per
// API process stands in for Kafka -> Redis -> WebSocket gateway. Each open
// stream gets only its own operator's changes (staff get all). A change is a
// signal to re-read, never data, so tenant isolation stays in the database.

type Send = (event: string, data: unknown) => void;

interface Subscriber {
  tenant: TenantContext;
  send: Send;
  close: () => void;
}

export class ChangeHub {
  private client: pg.Client | null = null;
  private readonly subs = new Set<Subscriber>();
  private stopped = false;
  private retryMs = 1000;

  constructor(
    private readonly connectionString: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  async start(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('notification', (msg) => {
      if (msg.channel !== CHANGES_CHANNEL || !msg.payload) return;
      try {
        this.fanout(JSON.parse(msg.payload) as Change);
      } catch {
        /* not ours */
      }
    });
    client.on('error', (err) => {
      this.log(`change listener lost: ${err.message}`);
      void this.reconnect();
    });
    await client.connect();
    await client.query(`LISTEN ${CHANGES_CHANNEL}`);
    this.client = client;
    this.retryMs = 1000;
  }

  // While disconnected, changes are missed; screens are told to re-read everything.
  private async reconnect(): Promise<void> {
    if (this.stopped || !this.client) return;
    const old = this.client;
    this.client = null;
    await old.end().catch(() => {});
    while (!this.stopped) {
      await new Promise((r) => setTimeout(r, this.retryMs));
      try {
        await this.start();
        for (const s of this.subs) s.send('resync', { reason: 'listener reconnected' });
        return;
      } catch (err) {
        this.retryMs = Math.min(30_000, this.retryMs * 2);
        this.log(`change listener retry failed: ${(err as Error).message}`);
      }
    }
  }

  subscribe(tenant: TenantContext, send: Send, close: () => void): () => void {
    const sub = { tenant, send, close };
    this.subs.add(sub);
    metrics.pushStreams.set(this.subs.size);
    return () => {
      this.subs.delete(sub);
      metrics.pushStreams.set(this.subs.size);
    };
  }

  fanout(change: Change): void {
    const sentAt = Date.now();
    const ageAtSendMs = change.receivedAt ? Math.max(0, sentAt - Date.parse(change.receivedAt)) : null;
    if (ageAtSendMs !== null) metrics.pushAgeAtSend.observe(ageAtSendMs / 1000);
    for (const s of this.subs) {
      if (s.tenant.role === 'platform_admin' || s.tenant.operatorId === change.op) s.send('change', { ...change, ageAtSendMs });
    }
  }

  // Ends every open stream, so the server can shut down.
  closeAll(): void {
    for (const s of [...this.subs]) s.close();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.closeAll();
    await this.client?.end().catch(() => {});
  }
}

// Receipt -> drawn on screen, as reported by dashboards. Untrusted input, so
// bounded: at most 100 samples a post, each 0-600 s, 10 posts per 10 s per
// tenant. Kept per tenant in a ring for /v1/freshness; the histogram is the
// durable record in production.
export class RenderSamples {
  private readonly rings = new Map<string, number[]>();
  private readonly posts = new Map<string, number[]>();
  constructor(private readonly keep = 5000) {}

  add(tenantKey: string, samplesSec: number[], nowMs = Date.now()): 'ok' | 'rate_limited' {
    const recent = (this.posts.get(tenantKey) ?? []).filter((t) => t > nowMs - 10_000);
    if (recent.length >= 10) return 'rate_limited';
    this.posts.set(tenantKey, [...recent, nowMs]);
    const ring = this.rings.get(tenantKey) ?? [];
    for (const s of samplesSec) {
      ring.push(s);
      metrics.receiptToRender.observe({ tenant: tenantKey }, s);
    }
    this.rings.set(tenantKey, ring.slice(-this.keep));
    return 'ok';
  }

  stats(tenantKey: string | null): { n: number; p50Sec: number | null; p95Sec: number | null; p999Sec: number | null } {
    const all = tenantKey === null ? [...this.rings.values()].flat() : (this.rings.get(tenantKey) ?? []);
    const sorted = [...all].sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : null);
    return { n: sorted.length, p50Sec: q(0.5), p95Sec: q(0.95), p999Sec: q(0.999) };
  }
}
