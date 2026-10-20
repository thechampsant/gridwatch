import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock.js';
import { CsmsClient, retryAfterSeconds, type FetchFn } from '../../src/csms/client.js';
import type { PollPage } from '../../src/csms/schemas.js';
import type { CallRecord, PollStore, SiteLease } from '../../src/ingest/poll-store.js';
import { nextPollDelaySec, pollSite, type PollerDeps, type PollerOptions } from '../../src/ingest/poller.js';
import { STUBS, stub } from '../helpers/fixtures.js';

// The poller against a scripted vendor: each test lines up the exact HTTP
// responses (from the stubs) and checks what the poller stored and decided.

const NOW = new Date('2026-06-09T09:05:00Z');
const HWM = new Date('2026-06-09T08:50:00Z');

const opts: PollerOptions = {
  minIntervalSec: 30,
  activeIntervalSec: 30,
  idleIntervalSec: 120,
  overlapSec: 300,
  initialLookbackSec: 86_400,
  reconcileEverySec: 3_600,
  reconcileWindowSec: 7_200,
  maxAttempts: 3,
  backoffBaseMs: 500,
  backoffCapMs: 4_000,
};

class MemoryStore implements PollStore {
  pages: { ref: string; page: PollPage }[] = [];
  calls: CallRecord[] = [];
  state: SiteLease & { nextPollAt: Date | null; lastOutcome: string | null } = {
    siteId: 'S-IN-0007',
    operatorId: 'acme-charge',
    connectionId: 'csms-main',
    highWaterMark: HWM,
    savedCursor: null,
    savedSince: null,
    consecutiveFailures: 0,
    lastReconciledAt: NOW,
    nextPollAt: null,
    lastOutcome: null,
  };
  lease(): SiteLease {
    return { ...this.state };
  }
  async claimDue() {
    return [this.lease()];
  }
  async markRequest() {}
  async storePage(_s: SiteLease, page: PollPage, _raw: unknown, ref: string) {
    this.pages.push({ ref, page });
  }
  async storeInvalidPage() {}
  async recordCall(c: CallRecord) {
    this.calls.push(c);
  }
  async hasActiveSession() {
    return false;
  }
  async completeCycle(_id: string, hwm: Date, _contact: Date, next: Date) {
    this.state.highWaterMark = this.state.highWaterMark && this.state.highWaterMark > hwm ? this.state.highWaterMark : hwm;
    Object.assign(this.state, { savedCursor: null, savedSince: null, consecutiveFailures: 0, nextPollAt: next, lastOutcome: 'ok' });
  }
  async rateLimited(_id: string, cursor: string | null, since: Date | null, next: Date) {
    Object.assign(this.state, { savedCursor: cursor, savedSince: since, nextPollAt: next, lastOutcome: 'rate_limited' });
  }
  async failCycle(_id: string, outcome: string, next: Date) {
    Object.assign(this.state, {
      consecutiveFailures: this.state.consecutiveFailures + 1,
      savedCursor: null,
      savedSince: null,
      nextPollAt: next,
      lastOutcome: outcome,
    });
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function scripted(steps: (() => Response | Error)[]) {
  const urls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    urls.push(url);
    const step = steps.shift();
    if (!step) throw new Error(`unexpected request ${url}`);
    const r = step();
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchFn, urls };
}

let store: MemoryStore;
let sleeps: number[];
const deps = (fetchFn: FetchFn): PollerDeps => ({
  client: new CsmsClient('http://vendor', fetchFn),
  store,
  clock: fixedClock(NOW),
  sleep: async (ms) => {
    sleeps.push(ms);
  },
  random: () => 0.5,
  opts,
});

beforeEach(() => {
  store = new MemoryStore();
  sleeps = [];
});

describe('poll cycle against the vendor stubs', () => {
  it('drains pages and advances the high-water mark only after the last page', async () => {
    const { fetchFn, urls } = scripted([() => json(200, stub(STUBS.page1)), () => json(200, stub(STUBS.page2))]);
    const r = await pollSite(deps(fetchFn), store.lease());
    expect(r).toEqual({ result: 'ok', pages: 2, events: 5 });
    expect(urls[1]).toContain('cursor=eyJvZmZzZXQiOjUwfQ%3D%3D');
    // since = high-water mark - overlap, on both pages
    expect(urls[0]).toContain(`since=${encodeURIComponent(new Date(HWM.getTime() - 300_000).toISOString())}`);
    expect(store.state.highWaterMark?.toISOString()).toBe('2026-06-09T09:02:25.000Z'); // vendor server_time
    expect(store.state.nextPollAt?.toISOString()).toBe(new Date(NOW.getTime() + 120_000).toISOString()); // idle site
  });

  it('429 mid-pagination: honours Retry-After, keeps the cursor, resumes from that page', async () => {
    const first = scripted([
      () => json(200, stub(STUBS.page1)),
      () => json(429, stub(STUBS.rateLimited), { 'retry-after': '30' }),
    ]);
    const r = await pollSite(deps(first.fetchFn), store.lease());
    expect(r).toEqual({ result: 'rate_limited', retryAfterSec: 30 });
    expect(sleeps).toEqual([]); // no immediate retry burst
    expect(store.state.highWaterMark).toEqual(HWM); // not advanced
    expect(store.state.savedCursor).toBe('eyJvZmZzZXQiOjUwfQ==');
    expect(store.state.nextPollAt?.toISOString()).toBe(new Date(NOW.getTime() + 30_000).toISOString());
    expect(store.calls.at(-1)?.handling).toContain('Retry-After: 30');

    const second = scripted([() => json(200, stub(STUBS.page2))]);
    const r2 = await pollSite(deps(second.fetchFn), store.lease());
    expect(r2.result).toBe('ok');
    expect(second.urls[0]).toContain('cursor=eyJvZmZzZXQiOjUwfQ%3D%3D'); // page 2, not page 1 again
    expect(store.pages.map((p) => p.page.events.length)).toEqual([4, 1]); // nothing fetched twice
  });

  it('500 then success: retries the same request with jittered backoff', async () => {
    store.state.siteId = 'S-DE-0003';
    const { fetchFn, urls } = scripted([() => json(500, stub(STUBS.serverError)), () => json(200, stub(STUBS.malformed))]);
    const r = await pollSite(deps(fetchFn), store.lease());
    expect(r.result).toBe('ok');
    expect(urls[0]).toBe(urls[1]); // same since, same request
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(0);
    expect(sleeps[0]).toBeLessThan(500);
    expect(store.calls[0]?.handling).toContain('req-7f3a9c');
    // The malformed page is stored as-is: bad events are dealt with one by one later.
    expect(store.pages).toHaveLength(1);
  });

  it('persistent 500: gives up after maxAttempts without advancing the high-water mark', async () => {
    const { fetchFn } = scripted([
      () => json(500, stub(STUBS.serverError)),
      () => json(500, stub(STUBS.serverError)),
      () => json(500, stub(STUBS.serverError)),
    ]);
    const r = await pollSite(deps(fetchFn), store.lease());
    expect(r).toEqual({ result: 'failed', reason: 'server_error_exhausted' });
    expect(store.state.highWaterMark).toEqual(HWM);
    expect(store.state.consecutiveFailures).toBe(1);
    expect(store.state.nextPollAt?.toISOString()).toBe(new Date(NOW.getTime() + 60_000).toISOString()); // backed off
  });

  it('failure part-way through pagination: next cycle repeats the same window from page 1', async () => {
    const netErr = () => new TypeError('fetch failed');
    const first = scripted([() => json(200, stub(STUBS.page1)), netErr, netErr, netErr]);
    const r = await pollSite(deps(first.fetchFn), store.lease());
    expect(r.result).toBe('failed');
    expect(store.pages).toHaveLength(1); // page 1 is already durable
    expect(store.state.highWaterMark).toEqual(HWM);
    expect(store.state.savedCursor).toBeNull();

    const second = scripted([() => json(200, stub(STUBS.page1)), () => json(200, stub(STUBS.page2))]);
    await pollSite(deps(second.fetchFn), store.lease());
    expect(second.urls[0]).toBe(first.urls[0]); // same since, no cursor: page 1 again (duplicates are harmless)
    expect(store.state.highWaterMark?.toISOString()).toBe('2026-06-09T09:02:25.000Z');
  });
});

describe('poll schedule', () => {
  it('polls sites with a session in progress every 30 s and idle sites less often', () => {
    expect(nextPollDelaySec({ active: true, consecutiveFailures: 0 }, opts)).toBe(30);
    expect(nextPollDelaySec({ active: false, consecutiveFailures: 0 }, opts)).toBe(120);
  });

  it('backs off exponentially after failures, capped at 5 minutes', () => {
    expect([1, 2, 3, 6].map((f) => nextPollDelaySec({ active: true, consecutiveFailures: f }, opts))).toEqual([60, 120, 240, 300]);
  });

  it('reads Retry-After as seconds, HTTP date, or the body field', () => {
    const now = new Date('2026-06-09T09:00:00Z');
    expect(retryAfterSeconds('30', '')).toBe(30);
    expect(retryAfterSeconds('Tue, 09 Jun 2026 09:00:45 GMT', '', now)).toBe(45);
    expect(retryAfterSeconds(null, '{"retry_after_seconds": 12}')).toBe(12);
    expect(retryAfterSeconds(null, '')).toBe(30);
  });
});
