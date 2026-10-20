import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SecretProvider } from '../archive/aws.js';
import { ReviewError, reviewSession, type ReviewDecision } from '../billing/review.js';
import { runSettlement } from '../billing/settlement.js';
import { parseAsOf, type Clock } from '../clock.js';
import { notifyChange } from '../db/changes.js';
import { withTenant, withTx, type Client, type Pool, type TenantContext } from '../db/pool.js';
import { CoverageError, coverageGaps, densityResError, hexDensity } from '../geo/coverage.js';
import { registry } from '../observability/metrics.js';
import { AuthError, issueToken, verifyToken } from './auth.js';
import { freshnessReport } from './freshness.js';
import { RenderSamples, type ChangeHub } from './stream.js';
import { availableConnectors, loadSiteViews, skipReason, type SiteView } from './site-status.js';
import { registerWebhook } from './webhook.js';

export interface ApiDeps {
  ingestPool: Pool; // webhook writes (ingest role)
  apiPool: Pool; // queries (api role, row-level security applies)
  secrets: SecretProvider;
  clock: Clock;
  jwtSecret: string;
  demoMode: boolean;
  demoNow?: string;
  staleAfterSec: number;
  publicDir?: string;
  logger?: boolean;
  billing?: { tolerance: number; graceSec: number }; // defaults: 1.1 and 2 h, as in config
  changes?: ChangeHub; // push to dashboards; off when absent
  renders?: RenderSamples;
}

const RenderBody = z.object({ samplesMs: z.array(z.number().min(0).max(600_000)).min(1).max(100) });

const ReviewBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('bill'), energyKwh: z.number().positive().max(1000), note: z.string().trim().min(5).max(500) }),
  z.object({ action: z.literal('void'), note: z.string().trim().min(5).max(500) }),
]);
const SESSION_STATUSES = new Set(['open', 'awaiting_start', 'charged', 'needs_review', 'voided']);

declare module 'fastify' {
  interface FastifyRequest {
    tenant: TenantContext | null;
  }
}

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  app.decorateRequest('tenant', null);
  const renders = deps.renders ?? new RenderSamples();
  // Open streams would hold the server open; end them first.
  app.addHook('preClose', async () => deps.changes?.closeAll());

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await deps.apiPool.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  registerWebhook(app, deps);

  // Every /v1 route needs a verified token. The tenant is taken from it and
  // nowhere else; an ?operator_id= in the URL is simply never read.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    try {
      req.tenant = await verifyToken(deps.jwtSecret, req.headers.authorization);
    } catch (err) {
      const message = err instanceof AuthError ? err.message : 'unauthorised';
      return reply.code(401).send({ error: message });
    }
  });

  const run = <T>(req: FastifyRequest, fn: (c: Client) => Promise<T>): Promise<T> =>
    withTenant(deps.apiPool, req.tenant!, async (c) => {
      if (req.tenant!.role === 'platform_admin') {
        await c.query(`INSERT INTO audit_log (subject, role, action, detail) VALUES ($1, $2, $3, $4)`, [
          req.tenant!.subject,
          req.tenant!.role,
          `${req.method} ${req.routeOptions.url}`,
          JSON.stringify(req.query ?? {}),
        ]);
      }
      return fn(c);
    });

  const asOf = (req: FastifyRequest) => {
    const q = req.query as Record<string, unknown>;
    return parseAsOf(q.as_of, deps.demoNow ? new Date(deps.demoNow) : deps.clock.now());
  };

  app.get('/v1/me', async (req) => req.tenant);

  app.get('/v1/sites/status', async (req, reply) => {
    let at: Date;
    try {
      at = asOf(req);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const sites = await run(req, (c) => loadSiteViews(c, at, deps.staleAfterSec));
    const conns = sites.flatMap((s) => s.connectors);
    const count = (st: string) => conns.filter((c) => c.status === st).length;
    return {
      asOf: at.toISOString(),
      staleAfterSec: deps.staleAfterSec,
      totals: {
        sites: sites.length,
        chargers: new Set(conns.map((c) => c.chargerId)).size,
        connectors: conns.length,
        status: { Available: count('Available'), Charging: count('Charging'), Faulted: count('Faulted'), Unknown: count('Unknown') },
        activeFaults: {
          critical: conns.filter((c) => c.fault?.severity === 'critical').length,
          warning: conns.filter((c) => c.fault && c.fault.severity !== 'critical').length,
        },
        staleSites: sites.filter((s) => s.stale).length,
        unresolvedSites: sites.filter((s) => s.geocode.status !== 'resolved').length,
      },
      sites,
    };
  });

  // GeoJSON for the map. Only geocoded sites have a point; the others are
  // listed separately so the UI can show them in a "needs location" queue.
  app.get('/v1/map/sites', async (req, reply) => {
    let at: Date;
    try {
      at = asOf(req);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const sites = await run(req, (c) => loadSiteViews(c, at, deps.staleAfterSec));
    const resolved = sites.filter((s) => s.geocode.lat !== null && s.geocode.lng !== null);
    return {
      type: 'FeatureCollection',
      asOf: at.toISOString(),
      features: resolved.map((s) => ({
        type: 'Feature',
        id: s.siteId,
        geometry: { type: 'Point', coordinates: [s.geocode.lng, s.geocode.lat] },
        properties: {
          siteId: s.siteId,
          name: s.name,
          rollup: s.rollup,
          stale: s.stale,
          lastContactAt: s.lastContact.at,
          lastContactVia: s.lastContact.via,
          lastContactAgeSec: s.lastContact.ageSec,
          geocodePrecision: s.geocode.precision,
          geocodeSource: s.geocode.source,
          geocodeNote: s.geocode.note,
          connectorsAvailable: availableConnectors(s).length,
          connectorsTotal: s.connectors.length,
          synthetic: s.synthetic,
        },
      })),
      unresolved: sites
        .filter((s) => s.geocode.lat === null)
        .map((s) => ({ siteId: s.siteId, name: s.name, address: s.address, geocodeStatus: s.geocode.status, reason: s.geocode.note })),
    };
  });

  // Nearest AVAILABLE charger: KNN on geography (true geodesic distance, GiST
  // index), then only connectors that are Available, fresh and free of
  // critical faults, inside the caller's tenant (row-level security).
  app.get('/v1/chargers/nearest', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const lat = Number(q.lat);
    const lng = Number(q.lng);
    const limit = Math.min(Math.max(Number(q.limit ?? 1) || 1, 1), 20);
    const maxKm = Math.min(Math.max(Number(q.max_km ?? 50) || 50, 0.1), 2000);
    const includeSynthetic = q.include_synthetic !== 'false';
    if (q.lat === undefined || q.lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return reply.code(400).send({ error: 'lat and lng are required decimal degrees' });
    }
    let at: Date;
    try {
      at = asOf(req);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    return run(req, async (c) => {
      const ranked = (
        await c.query<{ site_id: string; dist_m: number }>(
          `SELECT s.site_id, ST_Distance(s.location, q.p)::float8 AS dist_m
             FROM sites s, (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS p) q
            WHERE s.location IS NOT NULL AND ($3 OR NOT s.synthetic)
            ORDER BY s.location <-> q.p
            LIMIT 500`,
          [lng, lat, includeSynthetic],
        )
      ).rows;
      const views = new Map((await loadSiteViews(c, at, deps.staleAfterSec, ranked.map((r) => r.site_id))).map((v) => [v.siteId, v]));
      const brief = (v: SiteView, distM: number) => ({
        siteId: v.siteId,
        name: v.name,
        distanceKm: Math.round(distM) / 1000,
        geocodePrecision: v.geocode.precision,
        lastContactAt: v.lastContact.at,
      });

      const results = [];
      const skipped = [];
      let beyond = null;
      for (const r of ranked) {
        const v = views.get(r.site_id);
        if (!v) continue;
        const avail = availableConnectors(v);
        const within = r.dist_m <= maxKm * 1000;
        if (avail.length > 0) {
          if (within && results.length < limit) {
            results.push({ ...brief(v, r.dist_m), available: avail.map((a) => ({ chargerId: a.chargerId, connectorId: a.connectorId, maxKw: a.maxKw })) });
            continue;
          }
          if (!within && results.length === 0 && !beyond) beyond = brief(v, r.dist_m);
          if (results.length >= limit || !within) break;
        } else if (results.length === 0 && within) {
          skipped.push({ ...brief(v, r.dist_m), reason: skipReason(v) });
        }
      }
      return {
        asOf: at.toISOString(),
        from: { lat, lng },
        maxKm,
        rule: 'Available, recently confirmed by the vendor, no critical fault, within your tenant',
        results,
        skippedCloser: skipped,
        nearestBeyondRadius: results.length === 0 ? beyond : null,
      };
    });
  });

  // Density on the H3 grid: hexagons, ~1,770 km² areas with chargers per
  // 1,000 km², and a per-country line. Finer than resolution 6 is refused,
  // because most pins are postal-area centres (±2 km).
  app.get('/v1/coverage', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const res = q.res === undefined ? 6 : Number(q.res);
    const bad = densityResError(res);
    if (bad) return reply.code(400).send({ error: bad });
    const includeSynthetic = q.include_synthetic !== 'false';
    let at: Date;
    try {
      at = asOf(req);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return run(req, async (c) => {
      const views = (await loadSiteViews(c, at, deps.staleAfterSec)).filter((v) => includeSynthetic || !v.synthetic);
      const density = await hexDensity(c, { res, includeSynthetic, available: new Map(views.map((v) => [v.siteId, availableConnectors(v).length])) });
      return { asOf: at.toISOString(), ...density, unplacedSites: views.filter((v) => v.geocode.lat === null).length };
    });
  });

  // Where the network is thin: inside the metro areas it already serves, cells
  // more than max_km from any charger (static gap) or from one that is free
  // and working right now (live gap). Supply only: there is no demand data.
  app.get('/v1/coverage/gaps', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const maxKm = q.max_km === undefined ? 5 : Number(q.max_km);
    if (!Number.isFinite(maxKm) || maxKm < 1 || maxKm > 50) return reply.code(400).send({ error: 'max_km must be from 1 to 50' });
    const includeSynthetic = q.include_synthetic !== 'false';
    let at: Date;
    try {
      at = asOf(req);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    try {
      return await run(req, async (c) => {
        const views = await loadSiteViews(c, at, deps.staleAfterSec);
        const availableSiteIds = views.filter((v) => availableConnectors(v).length > 0).map((v) => v.siteId);
        return { asOf: at.toISOString(), ...(await coverageGaps(c, { maxKm, includeSynthetic, availableSiteIds })) };
      });
    } catch (err) {
      if (err instanceof CoverageError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // ?status=needs_review is the review queue, so it can't be pushed out of
  // the newest-200 window by a busy network.
  app.get('/v1/sessions', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const date = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : null;
    const status = q.status ?? null;
    if (status !== null && !SESSION_STATUSES.has(status)) return reply.code(400).send({ error: `status must be one of ${[...SESSION_STATUSES].join(', ')}` });
    const includeSynthetic = q.include_synthetic !== 'false';
    const tolerance = deps.billing?.tolerance ?? 1.1;
    const rows = await run(req, (c) =>
      c.query(
        `SELECT se.connection_id, se.session_id, se.operator_id, se.site_id, st.name AS site_name, st.timezone, st.synthetic,
                se.charger_id, se.connector_id, cg.max_kw::float8 AS max_kw,
                se.started_at, se.stopped_at, se.start_meter_wh, se.stop_meter_wh, se.energy_wh, se.energy_method,
                se.billing_status, se.review_reason, se.review_detail,
                CASE WHEN se.started_at IS NOT NULL AND se.stopped_at > se.started_at
                     THEN floor(cg.max_kw * 1000 * extract(epoch FROM se.stopped_at - se.started_at) / 3600 * $4)::bigint END AS plausible_max_wh,
                ch.business_date::text AS business_date, ch.currency, ch.price_per_kwh::text AS price_per_kwh,
                ch.session_fee::text AS session_fee, ch.energy_amount::text AS energy_amount,
                ch.total_amount::text AS total_amount, ch.tariff_id,
                rv.action AS review_action, rv.note AS review_note, rv.reviewed_by, rv.reviewed_at, rv.tariff_basis
           FROM sessions se
           JOIN sites st ON st.site_id = se.site_id
           JOIN chargers cg ON cg.charger_id = se.charger_id
           LEFT JOIN charges ch ON ch.connection_id = se.connection_id AND ch.session_id = se.session_id
           LEFT JOIN LATERAL (
             SELECT action, note, reviewed_by, reviewed_at, tariff_basis FROM session_reviews r
              WHERE r.connection_id = se.connection_id AND r.session_id = se.session_id
              ORDER BY review_id DESC LIMIT 1
           ) rv ON true
          WHERE ($1::date IS NULL OR ch.business_date = $1::date OR (se.stopped_at AT TIME ZONE st.timezone)::date = $1::date)
            AND ($2::text IS NULL OR se.billing_status = $2)
            AND ($3 OR NOT st.synthetic)
          ORDER BY coalesce(se.stopped_at, se.started_at) DESC NULLS LAST
          LIMIT 200`,
        [date, status, includeSynthetic, tolerance],
      ),
    );
    return { date, status, sessions: rows.rows };
  });

  // The exceptions queue: the operator that owns a held session bills a
  // confirmed amount or voids it. If that day was already settled, the
  // statement is re-issued as a new version straight away.
  app.post<{ Params: { connectionId: string; sessionId: string } }>('/v1/sessions/:connectionId/:sessionId/review', async (req, reply) => {
    if (req.tenant!.role !== 'operator') return reply.code(403).send({ error: 'only the operator that owns a session can review it' });
    const parsed = ReviewBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'send {action: "bill", energyKwh, note} or {action: "void", note}; the note (5-500 characters) says what was checked' });
    }
    const b = parsed.data;
    const decision: ReviewDecision = b.action === 'bill' ? { action: 'bill', energyWh: Math.round(b.energyKwh * 1000), note: b.note } : { action: 'void', note: b.note };
    const key: [string, string] = [req.params.connectionId, req.params.sessionId];
    let result;
    try {
      result = await withTenant(deps.apiPool, req.tenant!, (c) => reviewSession(c, key, decision, req.tenant!, deps.billing?.tolerance ?? 1.1));
    } catch (err) {
      if (err instanceof ReviewError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }

    await notifyChange(deps.ingestPool, { id: null, op: result.operatorId, sites: [], kinds: ['session'], receivedAt: null });
    // The review is committed and stands on its own; re-issuing is reported
    // separately, so a settlement problem never undoes the operator's decision.
    let statement: Record<string, unknown> = { status: 'not_settled_yet' };
    if (result.businessDate) {
      const settled = await deps.ingestPool.query(`SELECT 1 FROM settlement_statements WHERE operator_id = $1 AND business_date = $2 LIMIT 1`, [
        result.operatorId,
        result.businessDate,
      ]);
      if (settled.rowCount) {
        try {
          const r = await runSettlement(deps.ingestPool, result.operatorId, result.businessDate, {
            now: deps.clock.now(),
            graceSec: deps.billing?.graceSec ?? 7200,
          });
          statement = r.status === 'not_ready' ? { status: r.status, reason: r.reason } : { status: r.status, version: r.statement.version, businessDate: result.businessDate };
        } catch (err) {
          req.log.error(err);
          statement = { status: 'error', reason: (err as Error).message };
        }
      }
    }
    return { sessionId: key[1], billingStatus: result.billingStatus, review: result.review, statement };
  });

  app.get('/v1/settlement/statements', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const date = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : null;
    const rows = await run(req, (c) =>
      c.query(
        `SELECT DISTINCT ON (operator_id, business_date)
                operator_id, business_date::text AS business_date, version, currency, timezone, session_count,
                energy_wh, total_amount::text AS total_amount, held_count, voided_count, checksum, generated_at
           FROM settlement_statements
          WHERE $1::date IS NULL OR business_date = $1::date
          ORDER BY operator_id, business_date DESC, version DESC`,
        [date],
      ),
    );
    return { date, statements: rows.rows };
  });

  // The newest events (shown oldest first), with counts over all of them, so
  // a long-running network never freezes the log.
  app.get('/v1/ingestion/events', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(q.limit ?? 200) || 200, 1), 1000);
    const includeSynthetic = q.include_synthetic === 'true';
    const [rows, totals] = await run(req, (c) =>
      Promise.all([
        c.query(
          `SELECT * FROM (
             SELECT o.outcome_id, o.operator_id, o.site_id, o.source, o.delivery_ref, o.event_type, o.summary,
                    o.charger_id, o.connector_id, o.event_ts_local, o.event_ts, o.outcome, o.reason, o.received_at,
                    o.server_time, o.processed_at
               FROM ingest_outcomes o
              WHERE $1 OR NOT o.synthetic
              ORDER BY o.outcome_id DESC
              LIMIT $2) newest
           ORDER BY outcome_id`,
          [includeSynthetic, limit],
        ),
        c.query<{ outcome: string; n: number }>(
          `SELECT outcome, count(*)::int AS n FROM ingest_outcomes WHERE $1 OR NOT synthetic GROUP BY outcome`,
          [includeSynthetic],
        ),
      ]),
    );
    const counts: Record<string, number> = { applied: 0, stale: 0, duplicate: 0, quarantined: 0, held: 0 };
    for (const r of totals.rows) counts[r.outcome] = r.n;
    return {
      counts,
      shown: rows.rows.length,
      total: totals.rows.reduce((n, r) => n + r.n, 0),
      events: rows.rows.map((r) => ({ ...r, sourceLabel: sourceLabel(r.source, r.delivery_ref, r.site_id) })),
    };
  });

  app.get('/v1/freshness', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return run(req, (c) => freshnessReport(c, q.include_synthetic === 'true', renders.stats(req.tenant!.operatorId)));
  });

  // Dashboards report how long each pushed change took to reach the screen.
  app.post('/v1/freshness/render', async (req, reply) => {
    const body = RenderBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'send {samplesMs: [1-100 numbers, each 0-600000]}' });
    const key = req.tenant!.operatorId ?? 'platform_admin';
    if (renders.add(key, body.data.samplesMs.map((ms) => ms / 1000)) === 'rate_limited') return reply.code(429).send({ error: 'too many reports; send fewer, larger batches' });
    return reply.code(202).send({ accepted: body.data.samplesMs.length });
  });

  // One long-lived stream per dashboard: "hello", then a "change" whenever
  // the viewer's network changes, and a heartbeat. Server-Sent Events, read
  // with fetch(), so the token travels in a header and never in a URL.
  app.get('/v1/stream', async (req, reply) => {
    const hub = deps.changes;
    if (!hub) return reply.code(503).send({ error: 'live updates are off' });
    const tenant = req.tenant!;
    if (tenant.role === 'platform_admin') await run(req, async () => null); // audited once, when the stream opens
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    let beat: NodeJS.Timeout | undefined;
    let expiry: NodeJS.Timeout | undefined;
    let unsubscribe = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      clearTimeout(expiry);
      unsubscribe();
      res.end();
    };
    const send = (event: string, data: unknown) => {
      if (closed) return;
      // A client that stops reading is dropped, not buffered for.
      if (res.writableLength > 1_000_000) return close();
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    unsubscribe = hub.subscribe(tenant, send, close);
    beat = setInterval(() => send('ping', { serverTime: new Date().toISOString() }), 15_000);
    const ttl = (tenant.expiresAt ?? Date.now() + 8 * 3600_000) - Date.now();
    expiry = setTimeout(() => {
      send('expired', {});
      close();
    }, Math.min(Math.max(0, ttl), 2 ** 31 - 1));
    req.raw.on('close', close);
    send('hello', { serverTime: new Date().toISOString(), role: tenant.role, operatorId: tenant.operatorId });
  });

  const isAdmin = (req: FastifyRequest) => req.tenant?.role === 'platform_admin';

  app.get('/v1/admin/csms-calls', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'platform admins only' });
    // Counts cover every call. "notable" is the pilot sites' traffic from the
    // start (where the scripted 429 and 500 are); "recentErrors" the newest
    // failures anywhere; "calls" the newest of everything.
    const [counts, notable, recentErrors, calls] = await run(req, (c) =>
      Promise.all([
        c.query<{ total: number; rate_limited: number; poll_failed: number; bad_signature: number }>(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE status_code = 429)::int AS rate_limited,
                  count(*) FILTER (WHERE direction = 'poll' AND (status_code IS NULL OR status_code >= 500))::int AS poll_failed,
                  count(*) FILTER (WHERE outcome = 'bad_signature')::int AS bad_signature
             FROM csms_calls`,
        ),
        c.query(
          `SELECT k.* FROM csms_calls k LEFT JOIN sites s ON s.site_id = k.site_id
            WHERE (k.site_id IS NOT NULL AND NOT coalesce(s.synthetic, false))
               OR (k.site_id IS NULL AND k.request NOT LIKE '%dlv-live-%')
            ORDER BY k.call_id LIMIT 60`,
        ),
        c.query(`SELECT * FROM csms_calls WHERE status_code IS DISTINCT FROM 200 AND status_code IS DISTINCT FROM 202 ORDER BY call_id DESC LIMIT 20`),
        c.query(`SELECT * FROM csms_calls ORDER BY call_id DESC LIMIT 200`),
      ]),
    );
    const k = counts.rows[0]!;
    return {
      counts: { total: k.total, rateLimited: k.rate_limited, pollFailed: k.poll_failed, badSignature: k.bad_signature },
      notable: notable.rows,
      recentErrors: recentErrors.rows,
      calls: calls.rows,
    };
  });

  app.get('/v1/admin/quarantine', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'platform admins only' });
    const includeSynthetic = (req.query as Record<string, string | undefined>).include_synthetic === 'true';
    const [rows, counts] = await run(req, (c) =>
      Promise.all([
        c.query(
          `SELECT q.quarantine_id, q.inbox_id, q.event_index, q.operator_id, q.reason, q.detail, q.payload, q.created_at
             FROM quarantine q
             LEFT JOIN chargers ch ON ch.charger_id = q.payload->>'charger_id'
             LEFT JOIN sites s ON s.site_id = ch.site_id
            WHERE $1 OR NOT coalesce(s.synthetic, false)
            ORDER BY q.quarantine_id DESC LIMIT 200`,
          [includeSynthetic],
        ),
        c.query<{ reason: string; n: number }>(`SELECT reason, count(*)::int AS n FROM quarantine GROUP BY reason`),
      ]),
    );
    return { counts: Object.fromEntries(counts.rows.map((r) => [r.reason, r.n])), quarantine: rows.rows };
  });

  // The human step of the geocoding loop: operations pins a site whose address
  // couldn't be located (or was only approximate). The pin becomes a manual
  // override, which wins over every geocoder result from then on.
  app.post<{ Params: { siteId: string } }>('/v1/admin/sites/:siteId/location', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'platform admins only' });
    const body = (req.body ?? {}) as { lat?: unknown; lng?: unknown; note?: unknown };
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return reply.code(400).send({ error: 'lat and lng are required' });
    const site = (
      await deps.ingestPool.query<{ site_id: string; country: string; operator_id: string }>(`SELECT site_id, country, operator_id FROM sites WHERE site_id = $1`, [
        req.params.siteId,
      ])
    ).rows[0];
    if (!site) return reply.code(404).send({ error: 'unknown site' });
    const box = COUNTRY_BOUNDS[site.country];
    if (!box || lat < box.minLat || lat > box.maxLat || lng < box.minLng || lng > box.maxLng) {
      return reply.code(400).send({ error: `that point is outside ${site.country}; the pin was not saved` });
    }
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : 'placed from the dashboard map';
    await withTx(deps.ingestPool, async (c) => {
      await c.query(
        `INSERT INTO geocode_overrides (site_id, lat, lng, precision, note, created_by) VALUES ($1, $2, $3, 'rooftop', $4, $5)
         ON CONFLICT (site_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, precision = EXCLUDED.precision,
                note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = now()`,
        [site.site_id, lat, lng, note, req.tenant!.subject],
      );
      await c.query(
        `UPDATE sites SET location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, geocode_status = 'resolved',
                geocode_precision = 'rooftop', geocode_source = 'manual_override', geocode_confidence = 1,
                geocode_note = $4, geocoded_at = now()
          WHERE site_id = $1`,
        [site.site_id, lng, lat, `Pinned by operations: ${note}`],
      );
      await c.query(`INSERT INTO audit_log (subject, role, action, detail) VALUES ($1, $2, $3, $4)`, [
        req.tenant!.subject,
        req.tenant!.role,
        'POST /v1/admin/sites/:siteId/location',
        JSON.stringify({ siteId: site.site_id, lat, lng, note }),
      ]);
      await notifyChange(c, { id: null, op: site.operator_id, sites: [site.site_id], kinds: ['site'], receivedAt: null });
    });
    return { siteId: site.site_id, lat, lng, note: `Pinned by operations: ${note}` };
  });

  // DEMO ONLY: hands out tokens so the dashboard's "view as" switch works
  // without an identity provider. Not registered unless DEMO_MODE=true.
  if (deps.demoMode) {
    const personas: Record<string, { sub: string; role: TenantContext['role']; operator_id?: string }> = {
      'acme-charge': { sub: 'demo-acme-operator', role: 'operator', operator_id: 'acme-charge' },
      'stadtwerke-ev': { sub: 'demo-stadtwerke-operator', role: 'operator', operator_id: 'stadtwerke-ev' },
      platform_admin: { sub: 'demo-gridwatch-admin', role: 'platform_admin' },
    };
    app.post('/dev/token', async (req, reply) => {
      const as = (req.body as { as?: string } | undefined)?.as ?? '';
      const p = personas[as];
      if (!p) return reply.code(400).send({ error: `as must be one of ${Object.keys(personas).join(', ')}` });
      return { token: await issueToken(deps.jwtSecret, p), persona: as, demoOnly: true };
    });
  }

  if (deps.publicDir) {
    const files: Record<string, string> = {
      '/dashboard': 'dashboard.html',
      '/dashboard/': 'dashboard.html',
      '/dashboard/app.js': 'app.js',
      '/dashboard/app.css': 'app.css',
    };
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
    for (const [route, file] of Object.entries(files)) {
      app.get(route, async (_req, reply) => {
        const body = await readFile(path.join(deps.publicDir!, file), 'utf8');
        reply.header('content-type', types[path.extname(file)] ?? 'text/plain');
        reply.header('cache-control', 'no-cache');
        return body;
      });
    }
    app.get('/', async (_req, reply) => reply.redirect('/dashboard'));
  }

  return app;
}

// Rough country boxes: enough to catch a pin dropped in the wrong country.
const COUNTRY_BOUNDS: Record<string, { minLat: number; maxLat: number; minLng: number; maxLng: number }> = {
  IN: { minLat: 6, maxLat: 37.5, minLng: 68, maxLng: 97.5 },
  DE: { minLat: 47.2, maxLat: 55.1, minLng: 5.8, maxLng: 15.1 },
};

function sourceLabel(source: string, ref: string | null, siteId: string | null): string {
  if (source === 'webhook') return `Webhook ${ref ?? ''}`.trim();
  const m = /^(reconcile:)?([^#]+)#[^:]+:p(\d+)$/.exec(ref ?? '');
  if (!m) return `Poll ${siteId ?? ''}`.trim();
  return `${m[1] ? 'Reconcile' : 'Poll'} ${m[2]} · page ${m[3]}`;
}
