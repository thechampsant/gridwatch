import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { CsmsClient, PageResult } from '../csms/client.js';
import { metrics } from '../observability/metrics.js';
import type { PollStore, SiteLease } from './poll-store.js';

export interface PollerOptions {
  minIntervalSec: number; // vendor contract: at most one poll per site per 30 s
  activeIntervalSec: number; // sites with a session in progress (meter values only come by poll)
  idleIntervalSec: number; // everything else: reconciliation behind the webhook
  overlapSec: number; // since = high-water mark - overlap: pages aren't time-ordered
  initialLookbackSec: number;
  reconcileEverySec: number;
  reconcileWindowSec: number;
  maxAttempts: number; // per request, for 5xx / timeouts
  backoffBaseMs: number;
  backoffCapMs: number;
}

export interface PollerDeps {
  client: CsmsClient;
  store: PollStore;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  random: () => number; // [0, 1), injectable for deterministic tests
  opts: PollerOptions;
}

export type CycleResult =
  | { result: 'ok'; pages: number; events: number }
  | { result: 'rate_limited'; retryAfterSec: number }
  | { result: 'failed'; reason: string };

// Adaptive schedule. Polling every site every 30 s would be 12,000 / 30 =
// 400 req/s against a vendor that returns 500s under load. Only sites with a
// session in progress need 30 s (meter values arrive only by poll); idle
// sites are covered by webhooks and reconciled less often.
export function nextPollDelaySec(o: { active: boolean; consecutiveFailures: number }, opts: PollerOptions): number {
  if (o.consecutiveFailures > 0) {
    return Math.min(300, opts.minIntervalSec * 2 ** Math.min(o.consecutiveFailures, 4));
  }
  return Math.max(opts.minIntervalSec, o.active ? opts.activeIntervalSec : opts.idleIntervalSec);
}

// "Full jitter" exponential backoff: spreads retries so a struggling vendor
// isn't hit by synchronised bursts.
export function backoffMs(attempt: number, opts: PollerOptions, random: () => number): number {
  return Math.floor(random() * Math.min(opts.backoffCapMs, opts.backoffBaseMs * 2 ** (attempt - 1)));
}

// One poll cycle for one site: fetch every page, store each durably as it
// arrives, and only then advance the high-water mark.
export async function pollSite(deps: PollerDeps, site: SiteLease): Promise<CycleResult> {
  const { client, store, clock, opts } = deps;
  const now = clock.now();
  const addSec = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

  const reconcile =
    site.highWaterMark !== null &&
    (site.lastReconciledAt === null || now.getTime() - site.lastReconciledAt.getTime() > opts.reconcileEverySec * 1000);

  // Resume a pagination interrupted by a 429, otherwise start from the
  // high-water mark minus the overlap window (duplicates are harmless,
  // gaps are not).
  let since: Date | null;
  let cursor: string | null = site.savedCursor;
  if (cursor) {
    since = site.savedSince;
  } else if (site.highWaterMark) {
    since = addSec(site.highWaterMark, -(reconcile ? opts.reconcileWindowSec : opts.overlapSec));
  } else {
    since = addSec(now, -opts.initialLookbackSec);
  }

  const cycleId = randomUUID().slice(0, 8);
  let pages = 0;
  let events = 0;
  let firstServerTime: Date | null = null;
  let lastServerTime: Date | null = null;
  await store.markRequest(site.siteId, now);

  for (;;) {
    const query = { siteId: site.siteId, since, cursor };
    let result: PageResult;
    let okStarted = now;
    let okDurationMs = 0;
    for (let attempt = 1; ; attempt++) {
      const started = clock.now();
      result = await client.fetchPage(query);
      const durationMs = clock.now().getTime() - started.getTime();
      const record = (statusCode: number | null, outcome: string, handling: string) =>
        store.recordCall({ siteId: site.siteId, request: `GET ${client.path(query)}`, statusCode, outcome, handling, startedAt: started, durationMs });
      metrics.csmsRequests.inc({ outcome: result.kind });

      if (result.kind === 'ok') {
        okStarted = started;
        okDurationMs = durationMs;
        break;
      }
      if (result.kind === 'rate_limited') {
        await record(429, 'rate_limited', `Honour Retry-After: ${result.retryAfterSec}. The site's poll slot moves; no burst of retries.`);
        // Keep the cursor: after the wait we resume from this page, not page 1.
        await store.rateLimited(site.siteId, cursor, since, addSec(clock.now(), result.retryAfterSec));
        metrics.pollCycles.inc({ result: 'rate_limited' });
        return { result: 'rate_limited', retryAfterSec: result.retryAfterSec };
      }
      if (result.kind === 'server_error' || result.kind === 'timeout' || result.kind === 'network_error') {
        const status = result.kind === 'server_error' ? result.status : null;
        const label =
          result.kind === 'server_error' ? (result.requestId ?? `HTTP ${result.status}`) : result.kind === 'timeout' ? 'Timed out' : 'Network error';
        if (attempt < opts.maxAttempts) {
          await record(status, result.kind, `${label}. Retry with jittered backoff, same since value.`);
          await deps.sleep(backoffMs(attempt, opts, deps.random));
          continue;
        }
        await record(status, result.kind, `${label}. Gave up after ${attempt} attempts; high-water mark not advanced, so the next cycle repeats this window.`);
        return fail(deps, site, `${result.kind}_exhausted`);
      }
      // client_error or invalid_page: retrying the same request won't help.
      const status = result.status;
      const reason = result.kind === 'invalid_page' ? result.reason : `HTTP ${result.status}`;
      await record(status, result.kind, `Rejected (${reason}). Cycle aborted without advancing the high-water mark.`);
      if (result.kind === 'invalid_page') await store.storeInvalidPage(site, result.body, result.reason);
      return fail(deps, site, result.kind);
    }

    const { page, raw } = result;
    const serverTime = new Date(page.server_time);
    pages += 1;
    events += page.events.length;
    firstServerTime ??= serverTime;
    lastServerTime = serverTime;
    const deliveryRef = `${reconcile ? 'reconcile:' : ''}${site.siteId}#${cycleId}:p${pages}`;
    await store.storePage(site, page, raw, deliveryRef, serverTime);

    const n = page.events.length;
    const noun = n === 1 ? 'event' : 'events';
    const okCall = (handling: string) =>
      store.recordCall({
        siteId: site.siteId,
        request: `GET ${client.path(query)}`,
        statusCode: result.status,
        outcome: 'ok',
        handling,
        startedAt: okStarted,
        durationMs: okDurationMs,
      });
    if (page.next_cursor) {
      await okCall(`${n} ${noun} and a next_cursor, so fetch the next page.`);
      cursor = page.next_cursor;
      continue;
    }
    await okCall(
      `${n} ${noun}, no next_cursor: drained. High-water mark moves to server_time; the next poll asks from it minus an overlap window, because pages aren't time-ordered.`,
    );
    break;
  }

  const active = await store.hasActiveSession(site.siteId);
  const nextPollAt = addSec(clock.now(), nextPollDelaySec({ active, consecutiveFailures: 0 }, opts));
  await store.completeCycle(site.siteId, firstServerTime!, lastServerTime!, nextPollAt, reconcile);
  metrics.pollCycles.inc({ result: 'ok' });
  return { result: 'ok', pages, events };
}

async function fail(deps: PollerDeps, site: SiteLease, reason: string): Promise<CycleResult> {
  const delay = nextPollDelaySec({ active: false, consecutiveFailures: site.consecutiveFailures + 1 }, deps.opts);
  await deps.store.failCycle(site.siteId, reason, new Date(deps.clock.now().getTime() + delay * 1000));
  metrics.pollCycles.inc({ result: 'failed' });
  return { result: 'failed', reason };
}

// Trips when most recent cycles against a connection fail: the vendor is
// struggling, so stop adding load and probe again after a cool-down.
export class CircuitBreaker {
  private results: boolean[] = [];
  private openUntil = 0;

  constructor(
    private readonly window = 20,
    private readonly minSamples = 10,
    private readonly failureRatio = 0.5,
    private readonly coolDownMs = 60_000,
  ) {}

  record(ok: boolean, now = Date.now()): void {
    this.results.push(ok);
    if (this.results.length > this.window) this.results.shift();
    const failures = this.results.filter((r) => !r).length;
    if (this.results.length >= this.minSamples && failures / this.results.length >= this.failureRatio) {
      this.openUntil = now + this.coolDownMs;
      this.results = [];
    }
  }

  isOpen(now = Date.now()): boolean {
    return now < this.openUntil;
  }
}
