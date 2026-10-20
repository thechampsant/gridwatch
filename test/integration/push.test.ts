import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { StaticSecretProvider } from '../../src/archive/aws.js';
import { issueToken } from '../../src/api/auth.js';
import { buildServer } from '../../src/api/server.js';
import { ChangeHub } from '../../src/api/stream.js';
import { fixedClock } from '../../src/clock.js';
import { CHANGES_CHANNEL } from '../../src/db/changes.js';
import { STUBS, stub } from '../helpers/fixtures.js';
import { drain, enqueue, pools, resetDb, urls } from './db.js';

// Push to dashboards: a committed change is announced once, only to the
// operator it belongs to (and staff), and screens report how long it took.

const JWT = 'test-jwt-secret';
const { admin, ingest, api } = pools();
const hub = new ChangeHub(urls.api);
let app: FastifyInstance;
let base: string;
let acme: string;
let stadtwerke: string;
let platform: string;

beforeAll(async () => {
  await hub.start();
  app = await buildServer({
    ingestPool: ingest,
    apiPool: api,
    secrets: new StaticSecretProvider(['unused']),
    clock: fixedClock('2026-06-09T13:15:00Z'),
    jwtSecret: JWT,
    demoMode: false,
    staleAfterSec: 300,
    changes: hub,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  acme = await issueToken(JWT, { sub: 't-acme', role: 'operator', operator_id: 'acme-charge' });
  stadtwerke = await issueToken(JWT, { sub: 't-stw', role: 'operator', operator_id: 'stadtwerke-ev' });
  platform = await issueToken(JWT, { sub: 't-admin', role: 'platform_admin' });
});
afterAll(async () => {
  await app.close();
  await hub.stop();
  await Promise.all([admin.end(), ingest.end(), api.end()]);
});
beforeEach(async () => {
  await resetDb(admin);
});

const until = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
};

type Msg = { event: string; data: { op?: string; kinds?: string[]; ageAtSendMs?: number | null } };
async function openStream(token?: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/v1/stream`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ctrl.signal });
  const msgs: Msg[] = [];
  if (res.ok && res.body) {
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event) msgs.push({ event, data: data ? JSON.parse(data) : null });
          }
        }
      } catch {
        /* aborted */
      }
    })();
  }
  return { status: res.status, msgs, close: () => ctrl.abort() };
}

describe('change notifications from the processor', () => {
  it('announces a committed change once, and stays quiet for re-reads and bad payloads', async () => {
    const listener = new pg.Client({ connectionString: urls.admin });
    await listener.connect();
    const got: { op: string; kinds: string[] }[] = [];
    listener.on('notification', (m) => got.push(JSON.parse(m.payload!)));
    await listener.query(`LISTEN ${CHANGES_CHANNEL}`);
    try {
      await enqueue(ingest, 'poll', stub(STUBS.page1));
      await drain(ingest);
      expect(await until(() => got.length > 0)).toBe(true);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ op: 'acme-charge' });
      expect(got[0]!.kinds).toEqual(expect.arrayContaining(['status', 'meter']));

      await enqueue(ingest, 'poll', stub(STUBS.page1), 'S-IN-0007#again:p1'); // every event a duplicate now
      await enqueue(ingest, 'poll', { site_id: 'S-IN-0007', events: 'not a list' } as never, 'S-IN-0007#bad:p1');
      await drain(ingest);
      await new Promise((r) => setTimeout(r, 300));
      expect(got).toHaveLength(1);
    } finally {
      await listener.end();
    }
  });
});

describe('the change stream', () => {
  it("sends each operator only its own changes; staff get everyone's", async () => {
    const [a, s, p] = await Promise.all([openStream(acme), openStream(stadtwerke), openStream(platform)]);
    try {
      expect(await until(() => [a, s, p].every((x) => x.msgs.some((m) => m.event === 'hello')))).toBe(true);
      await enqueue(ingest, 'poll', stub(STUBS.page1)); // Acme's Noida site
      await drain(ingest);
      expect(await until(() => a.msgs.some((m) => m.event === 'change') && p.msgs.some((m) => m.event === 'change'))).toBe(true);
      const change = a.msgs.find((m) => m.event === 'change')!.data;
      expect(change.op).toBe('acme-charge');
      expect(change.ageAtSendMs).toBeGreaterThanOrEqual(0);
      await new Promise((r) => setTimeout(r, 300));
      expect(s.msgs.some((m) => m.event === 'change')).toBe(false);
    } finally {
      for (const x of [a, s, p]) x.close();
    }
  });

  it('needs a token', async () => {
    const r = await openStream();
    expect(r.status).toBe(401);
  });
});

describe('render reports', () => {
  const post = (body: unknown, token = acme) =>
    app.inject({ method: 'POST', url: '/v1/freshness/render', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

  it('feeds the tile verdict, and says it is still measuring below 1,000 samples', async () => {
    expect((await post({ samplesMs: [420, 610, 380] })).statusCode).toBe(202);
    const f = (await app.inject({ method: 'GET', url: '/v1/freshness', headers: { authorization: `Bearer ${acme}` } })).json();
    const tile = f.signals.find((x: { key: string }) => x.key === 'tile');
    expect(tile.verdict).toBe('ours_measuring');
    expect(tile.render.n).toBeGreaterThanOrEqual(3);
  });

  it('rejects nonsense and floods', async () => {
    expect((await post({ samplesMs: [-1] })).statusCode).toBe(400);
    expect((await post({ samplesMs: new Array(101).fill(5) })).statusCode).toBe(400);
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await post({ samplesMs: [100] }, stadtwerke)).statusCode);
    expect(codes).toContain(429);
  });
});
