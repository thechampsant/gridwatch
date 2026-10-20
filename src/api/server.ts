import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { SecretProvider } from '../archive/aws.js';
import { parseAsOf, type Clock } from '../clock.js';
import { withTenant, type Client, type Pool, type TenantContext } from '../db/pool.js';
import { registry } from '../observability/metrics.js';
import { AuthError, issueToken, verifyToken } from './auth.js';
import { freshnessReport } from './freshness.js';
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
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant: TenantContext | null;
  }
}

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  app.decorateRequest('tenant', null);

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
          connectorsAvailable: availableConnectors(s).length,
          connectorsTotal: s.connectors.length,
          synthetic: s.synthetic,
        },
      })),
      unresolved: sites
        .filter((s) => s.geocode.lat === null)
        .map((s) => ({ siteId: s.siteId, name: s.name, address: s.address, geocodeStatus: s.geocode.status })),
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
            WHERE s.location IS NOT NULL
            ORDER BY s.location <-> q.p
            LIMIT 500`,
          [lng, lat],
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

  app.get('/v1/sessions', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const date = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : null;
    const rows = await run(req, (c) =>
      c.query(
        `SELECT se.session_id, se.operator_id, se.site_id, st.name AS site_name, st.timezone, se.charger_id, se.connector_id,
                se.started_at, se.stopped_at, se.start_meter_wh, se.stop_meter_wh, se.energy_wh, se.energy_method,
                se.billing_status, se.review_reason, se.review_detail,
                ch.business_date::text AS business_date, ch.currency, ch.price_per_kwh::text AS price_per_kwh,
                ch.session_fee::text AS session_fee, ch.energy_amount::text AS energy_amount,
                ch.total_amount::text AS total_amount, ch.tariff_id
           FROM sessions se
           JOIN sites st ON st.site_id = se.site_id
           LEFT JOIN charges ch ON ch.connection_id = se.connection_id AND ch.session_id = se.session_id
          WHERE $1::date IS NULL OR ch.business_date = $1::date OR (se.stopped_at AT TIME ZONE st.timezone)::date = $1::date
          ORDER BY coalesce(se.stopped_at, se.started_at) DESC NULLS LAST
          LIMIT 200`,
        [date],
      ),
    );
    return { date, sessions: rows.rows };
  });

  app.get('/v1/settlement/statements', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const date = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : null;
    const rows = await run(req, (c) =>
      c.query(
        `SELECT DISTINCT ON (operator_id, business_date)
                operator_id, business_date::text AS business_date, version, currency, timezone, session_count,
                energy_wh, total_amount::text AS total_amount, held_count, checksum, generated_at
           FROM settlement_statements
          WHERE $1::date IS NULL OR business_date = $1::date
          ORDER BY operator_id, business_date DESC, version DESC`,
        [date],
      ),
    );
    return { date, statements: rows.rows };
  });

  app.get('/v1/ingestion/events', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(q.limit ?? 200) || 200, 1), 1000);
    const includeSynthetic = q.include_synthetic === 'true';
    const rows = await run(req, (c) =>
      c.query(
        `SELECT o.outcome_id, o.operator_id, o.site_id, o.source, o.delivery_ref, o.event_type, o.summary,
                o.charger_id, o.connector_id, o.event_ts_local, o.event_ts, o.outcome, o.reason, o.received_at,
                o.server_time, o.processed_at
           FROM ingest_outcomes o
           LEFT JOIN sites s ON s.site_id = o.site_id
          WHERE $1 OR NOT coalesce(s.synthetic, false)
          ORDER BY o.outcome_id
          LIMIT $2`,
        [includeSynthetic, limit],
      ),
    );
    const counts: Record<string, number> = { applied: 0, stale: 0, duplicate: 0, quarantined: 0, held: 0 };
    for (const r of rows.rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    return { counts, events: rows.rows.map((r) => ({ ...r, sourceLabel: sourceLabel(r.source, r.delivery_ref, r.site_id) })) };
  });

  app.get('/v1/freshness', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return run(req, (c) => freshnessReport(c, q.include_synthetic === 'true'));
  });

  const isAdmin = (req: FastifyRequest) => req.tenant?.role === 'platform_admin';

  app.get('/v1/admin/csms-calls', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'platform admins only' });
    const rows = await run(req, (c) => c.query(`SELECT * FROM csms_calls ORDER BY call_id LIMIT 500`));
    return { calls: rows.rows };
  });

  app.get('/v1/admin/quarantine', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'platform admins only' });
    const rows = await run(req, (c) =>
      c.query(`SELECT quarantine_id, inbox_id, event_index, operator_id, reason, detail, payload, created_at
                 FROM quarantine ORDER BY quarantine_id DESC LIMIT 200`),
    );
    return { quarantine: rows.rows };
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

function sourceLabel(source: string, ref: string | null, siteId: string | null): string {
  if (source === 'webhook') return `Webhook ${ref ?? ''}`.trim();
  const m = /^(reconcile:)?([^#]+)#[^:]+:p(\d+)$/.exec(ref ?? '');
  if (!m) return `Poll ${siteId ?? ''}`.trim();
  return `${m[1] ? 'Reconcile' : 'Poll'} ${m[2]} · page ${m[3]}`;
}
