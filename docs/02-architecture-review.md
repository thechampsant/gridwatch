# Part B — Review of "GridWatch Platform — Architecture Draft v0.3"

**Verdict: not ready to go to a client.** The draft has a sensible shape (vendor feed → Kafka → consumers → Postgres → API → map), but five problems would hurt the business from day one:

1. **Any logged-in user can read every other CPO's data.** The tenant is taken from a URL parameter (§6).
2. **Settlement will double-bill, and can invoice negative amounts.** It assumes each `session.stop` arrives once (§7).
3. **The freshness promise cannot be met through this vendor interface,** and the draft says the opposite (§3).
4. **The database disk fills in about 28 hours, not "a year"** (§10).
5. **The HA section contradicts itself:** async replication is claimed as RPO 0, and Kafka and Redis are single nodes against a 99.9% target (§8, §9, §13).

Points 1, 2 and 5 are fixed in the Part C slice and Part A design. Points 3 and 4 need a conversation with the client and the vendor as much as a design change.

---

## How the findings are ranked

Each finding is scored on four things, in this order:

1. **Business impact.** Money (billing errors, refunds), contract (freshness penalties), legal (cross-tenant data exposure, GDPR / DPDP), then operability.
2. **Blast radius.** Every tenant, one country's tenants, or one feature.
3. **Time to hurt.** Day one of the pilot, the first incident, or month six at full scale.
4. **Detectability.** Silent errors (wrong invoices, a stale map that looks live) rank above loud ones (a crash).

**Critical** means money, legal or contract damage across tenants from day one, or a failure that silently corrupts data. **High** means a core feature is wrong or breaks at production scale. **Medium** means operational risk, cost, or a gap that bites later.

## Summary

| ID | Finding | Severity | Blast radius | Time to hurt | Draft § |
|---|---|---|---|---|---|
| C1 | Tenant scope comes from a query parameter | Critical | All tenants | Day 1 | §6 |
| C2 | Settlement double-bills redelivered stops and can go negative | Critical | All revenue | Day 1 | §7 |
| C3 | Freshness KPIs declared met but impossible via the vendor interface | Critical | Contract, all tenants | Day 1 | §1, §3 |
| C4 | Storage sizing off by ~300×; single small node | Critical | Whole platform | ~Day 2 | §4.2, §10 |
| C5 | HA/DR claims contradict the design; single points of failure | Critical | Whole platform | First incident | §8, §9, §13 |
| C6 | Settlement runs on India's clock for German tenants; money rules unspecified | Critical | All German revenue | Day 1, silent | §7 |
| H1 | No event-time ordering: stale status overwrites newer | High | Map and alerts | Day 1 | §3 |
| H2 | No de-duplication anywhere (poll + webhook + Kafka redelivery) | High | All data | Day 1 | §3 |
| H3 | Poller ignores rate limits, errors and cursors; 400 req/s at scale | High | Vendor relationship, data gaps | First vendor hiccup | §3 |
| H4 | The map has no coordinates: the vendor sends none | High | The core product | Day 1 | §4.1 |
| H5 | "Nearest charger" is wrong, slow, and not tenant-scoped | High | Map, all tenants | Day 1 | §5.1 |
| H6 | Telemetry table: unpartitioned jsonb, wrong index, no retention | High | Whole DB | Weeks | §4.2 |
| H7 | Webhook auth is a static header, not the vendor's HMAC; ack timing undefined | High | Data integrity, billing | Day 1 | §3, §11 |
| H8 | Observability can't prove (or disprove) a single KPI | High | Contract disputes | First complaint | §12 |
| H9 | Map/tile serving by full re-poll every 10 s from hot OLTP tables | High | Freshness, DB load | At scale | §5 |
| M1–M7 | See the medium table | Medium | Varies | Later | Various |

---

## Critical

### C1. Tenant scope comes from a query parameter (§6)

**Evidence.** "The Dashboard API scopes queries by the `operator_id` that the frontend sends as a query parameter."

**Why it hurts.** Any authenticated user of any CPO can change `?operator_id=acme` to a competitor's ID and read their sites, sessions, revenue and faults. This is an IDOR (insecure direct object reference) on the platform's core promise. A competitor's data leaking is a contract breach, and a personal-data breach as soon as session data includes anything personal (GDPR in Germany, DPDP in India). It is also invisible: nothing errors.

**Fix.**
- Take the tenant only from the verified token issued by Keycloak (an `operator_id` claim), never from the request.
- Enforce it a second time in Postgres with row-level security: every tenant table gets a policy on `operator_id = current_setting('app.operator_id')`, set per transaction. A forgotten `WHERE` clause then returns no rows instead of everyone's rows.
- Give GridWatch staff a separate audited role for cross-tenant access.
- Part C implements all three and tests that `?operator_id=` is ignored.

**Verify.**
- A penetration test case for every endpoint.
- The API's database role does not own the tables and has no `BYPASSRLS`.

### C2. Settlement double-bills and can invoice negative amounts (§7)

**Evidence.** "Because each session produces exactly one `session.stop` event, no deduplication is needed on the settlement side — one stop event, one invoice." And: "computes energy delivered (`stop_meter_wh - start_meter_wh`)".

**Why it hurts.** The premise is false three times over:
- **The vendor redelivers.** Webhooks are at-least-once, and stub 2b is the same `session.stop` with a new `delivery_id`.
- **The draft's own design duplicates it.** The 30 s poll backstop returns the same stop again.
- **Kafka redelivers too.** It is at-least-once, so a consumer rebalance replays uncommitted offsets.

Every duplicate becomes a second invoice line, and customers are double-billed. Separately, stub 2d (a meter reset or replacement mid-session) gives `31,200 − 12,044,990 = −12,013,790 Wh`, so the naive formula produces a negative invoice. Both errors are silent and land on the CPO's reconciliation.

**Fix.**
- **Billing is idempotent by construction.** One charge per session, with `UNIQUE (connection_id, session_id)` and `ON CONFLICT DO NOTHING`.
- **Settlement works from merged session records,** not raw events. Start and stop can arrive in any order.
- **Meter resets are handled explicitly.** Rebuild the energy from interval readings when they bracket the reset; otherwise hold the session for review. Never bill negative energy.
- **A plausibility check holds physically impossible sessions:** energy must not exceed `max_kw × duration × tolerance`. The stubs contain one. `sess-in-44a` reports 11.667 kWh in 7 min 19 s, about 96 kW average on a 60 kW charger, while its own meter readings show about 41 kW.

**Verify.**
- Ask the CPO whether a held session (not invoiced until reviewed) is acceptable, versus invoicing and correcting later.
- Ask how many meter replacements happen per month.

### C3. The freshness KPIs are declared met but cannot be met through this interface (§3, §1)

**Evidence.** "Because we poll every 30 seconds and also receive webhooks within 60 seconds, dashboard data is always fresh enough to meet the < 5 s and < 2 s KPIs above."

**Why it hurts.** The reasoning is backwards: a 30 s poll interval and up-to-60 s webhook batching are delays *larger* than 5 s.
- Status and faults can be up to 60 s old when the vendor delivers them.
- Meter values (power, energy) only arrive by poll, so the < 10 s P99.9 target is missed by design.
- The platform is "sold on freshness" with these numbers in the contract.

Signing this means breaching the contract on day one, without the data to show it is the vendor's delay rather than ours (see H8).

**Fix.** Raise it with the client before signing.
- Define each KPI from GridWatch's receipt of the data (which we control and can meet), and report the vendor's share separately.
- Ask the vendor for unbatched webhooks, meter values on the webhook, or a streaming feed.
- Show data age on every tile and map marker, so a stale value never looks live.

Part A §8 has the per-KPI verdict table.

**Verify.**
- Is the contract clock started at the charger, at the vendor, or at our receipt?
- Can the vendor's webhook batching window be configured?

### C4. Storage sizing is off by about 300× (§4.2, §10)

**Evidence.**
- The draft's own figures: "5,000 × 2 KB ≈ 10 MB/sec, or about 864 GB/day".
- Then: a "1 TB SSD … gives us roughly a year of telemetry headroom", on "a single 4 vCPU / 8 GB RAM instance", with telemetry kept "indefinitely".

**Why it hurts.**
- The arithmetic is right; the conclusion isn't. 1 TB ÷ 864 GB/day ≈ 1.2 days (about 28 hours), before indexes and WAL. The database stops accepting writes on day two of production.
- The rate is also probably low. Meter values are per connector, so about 2 per charger gives about 10k/s, not 5k/s.
- A 4 vCPU / 8 GB node cannot sustain 5,000–10,000 jsonb inserts per second while also serving dashboards from the same tables (H9) and vacuuming one ever-growing table (H6).

**Fix.**
- **Narrow, typed telemetry rows:** timestamp, integer connector key, Wh, W. That is about 60–90 bytes with index, versus 2 KB of jsonb.
- **TimescaleDB hypertables** with compression once data is past its lateness window (about 10× smaller) and a retention policy: raw data 90 days, rollups for years.
- **Telemetry in its own database cluster,** separate from core and billing.
- At production scale that is about 8 GB/day compressed. The arithmetic is in Part A §10.

**Verify.**
- Real connectors per charger.
- How often chargers send meter values when idle (often only during sessions).
- How long the client must retain raw telemetry, as opposed to rollups.

### C5. HA/DR claims contradict the design (§8, §9, §13)

**Evidence.**
- "streaming replication in asynchronous mode … RPO: 0", and "RTO: 5 minutes" with "the on-call engineer … promotes the standby manually".
- "Whether to add a second Kafka broker … in a later phase" (§13).
- "We run one Redis instance" (§8).
- The target is 99.9% monthly (§1).

**Why it hurts.**
- **Async replication cannot give RPO 0.** Commits acknowledged on the primary but not yet shipped are lost on failover.
- **Manual promotion is not a 5-minute RTO.** Page, wake, acknowledge, diagnose, promote and repoint the applications: realistically 15–60 minutes at 3 a.m. A 99.9% month allows 43 minutes, so one night-time failover can use the whole budget.
- **A single Kafka broker is the single point of failure for all ingestion.** The draft's "guarantees we never lose an event" (§3) is false with replication factor 1: a disk loss loses everything not yet consumed.
- **One Redis node** means a restart logs out every user of every tenant (M1).

**Fix.**
- **Core and billing Postgres:** synchronous quorum replication with automated failover (Patroni, or a managed Multi-AZ service). RPO 0, RTO under about a minute.
- **Telemetry Postgres:** may stay async, because it can be rebuilt from Kafka. After a failover, rewind consumer offsets by a safety margin; idempotent sinks absorb the replay.
- **Kafka:** 3 brokers across availability zones, replication factor 3, `min.insync.replicas = 2`, `acks = all`.
- **Redis:** replicated, holding only rebuildable cache, never login sessions.
- **State RPO/RTO per component** (Part A §9).

**Verify.**
- Whether a whole-region outage is inside the 99.9% SLA or treated as a separately agreed DR event.
- The client's data-residency constraints on where the DR copy may live.

### C6. Settlement runs on India's clock for German tenants; money rules are unspecified (§7)

**Evidence.** "A daily settlement job at 02:00 IST sums the previous day's invoices per CPO". Also: "converts to local currency".

**Why it hurts.** 02:00 IST is 20:30 UTC, which is 22:30 CEST the previous evening, so the German day isn't over when the run starts.
- Stub `sess-de-99x` stops at 23:14:58+02:00 = 21:14:58 UTC = 02:44:58 IST on 10 June. That is after the run, and it gets booked to the wrong day.
- Every German CPO reconciles against wrong daily totals, silently, every day.
- "Converts to local currency" is undefined. Tariffs are presumably already in INR or EUR; if foreign-exchange conversion is meant, it needs a dated rate source and rules.
- The money type, rounding rule and tax handling are not mentioned.

**Fix.**
- **Business day in each operator's IANA zone** (`Asia/Kolkata`, `Europe/Berlin`), never a fixed offset, because Germany changes with DST.
- **Run each operator's settlement after its local midnight,** plus a grace period, gated on a watermark: every site has been polled past the end of the day.
- **Attribute a session by its local stop time.**
- **Version the statements, never edit them.** Late data issues version 2.
- **Use `NUMERIC` money with half-up rounding** to the minor unit per line.
- Part C implements and tests all of this.

**Verify.**
- Which time defines a session's day: start or stop?
- Is GridWatch's settlement the legal invoice (GST/VAT, numbering, retention, German calibration law) or a reconciliation ledger?
- Is foreign exchange ever needed?

---

## High

### H1. No event-time ordering (§3)
- **Problem.** Consumers write what they receive. Stub 2c delivers `Charging @14:31:50` after `Available @14:33:40`, so the map shows a free charger as busy.
- **Fix.** Last-write-wins by event timestamp, guarded in the database upsert (`WHERE new.ts > current.ts`), with a deterministic tie-break for equal timestamps. Part C tests all 24 orderings of that batch.

### H2. No de-duplication anywhere (§3)
- **Problem.** Poll and webhook both publish the same events to `telemetry`, and Kafka redelivers on rebalance. Telemetry rows, session counts and analytics all inflate.
- **Fix.** Idempotency by natural key at every sink (meter reading = connector + timestamp; session = connection + session_id) with `ON CONFLICT DO NOTHING`. Treat "exactly-once" as something the sinks provide, not the transport.

### H3. The poller has no failure handling and doesn't scale (§3)
- **Problem.**
  - "Polls … every 30 seconds" for 12,000 sites is 400 requests/s against a vendor that returns 500s under load and 429s per site.
  - There is no mention of `Retry-After`, backoff, pagination cursors or high-water marks.
  - The likely failure modes are data gaps (a cursor advanced past a failed page) and retry storms that make the vendor's outage worse.
- **Fix.**
  - A lease-based scheduler.
  - Adaptive polling: 30 s only for sites with a session in progress, minutes otherwise, because the webhook covers status.
  - Honour `Retry-After`; jittered exponential backoff; a circuit breaker per connection.
  - Advance the high-water mark from the vendor's `server_time` only after every page is durably stored, and re-ask with an overlap window, because pages aren't time-ordered.

### H4. The map has no coordinates (§4.1)
- **Problem.** `sites` has latitude and longitude, but the vendor sends only an address string. Nothing fills them, so the map, "the heart of the product", is empty on day one.
- **Fix.**
  - An asynchronous geocoding pipeline at onboarding: manual override, then a licensed provider whose terms allow storing results, then a postal-code fallback.
  - Record precision and source with every pin.
  - Unresolved sites go to an operations queue, not onto the map.
- **Verify.** The provider's terms on caching (Google's, for example, limit it).

### H5. "Nearest charger" is wrong, slow and leaks across tenants (§5.1)
- **Problem.**
  - **Wrong distance.** `ORDER BY (lat − :lat)^2 + (lng − :lng)^2` treats a degree of longitude as equal to a degree of latitude. At Stuttgart (48.8° N) a degree of longitude is about 0.66 of one of latitude, so the ranking is wrong.
  - **Slow.** No index can serve that expression, so it is a full scan and sort per request.
  - **Wrong grain.** `c.status = 'available'` filters chargers, but status lives on connectors, and OCPP spells it `Available`.
  - **No freshness check,** so it recommends a charger whose status is hours old.
  - **No tenant predicate at all.** It returns any CPO's charger.
- **Fix.** PostGIS `geography(Point, 4326)` with a GiST index and KNN (`ORDER BY location <-> :point`, `ST_DWithin` for the radius). Availability is per connector, and fresh. Tenant scope via RLS. Implemented and tested in Part C.

### H6. The telemetry table will fall over (§4.2)
- **Problem.**
  - One unpartitioned table with a jsonb payload and an index on `charger_id` only, so time-range queries still read huge index ranges.
  - "No partitioning is required."
  - Deleting history means a giant `DELETE` and vacuum on a multi-TB table.
- **Fix.** A hypertable partitioned by time; typed columns; primary key `(charger, connector, ts)`; compression; retention; continuous aggregates for the dashboards.

### H7. Webhook authentication and acknowledgement (§3, §11)
- **Problem.**
  - "Validated against a shared secret in the request header" is a bearer password. If it ever appears in a log, anyone can inject sessions, and therefore invoices.
  - The vendor actually sends `X-CSMS-Signature`, an HMAC-SHA256 of the body, which the design should use.
  - The draft also doesn't say when it answers 2xx. If it acknowledges before Kafka has the batch, a Kafka outage silently loses data the vendor will never redeliver.
- **Fix.**
  - Verify the HMAC over the raw bytes with a constant-time compare.
  - Per-connection secrets in a secrets manager, with two valid during rotation.
  - Acknowledge only after a durable write; otherwise return 503 so the vendor redelivers.

### H8. Observability can't prove the KPIs (§12)
- **Problem.** Host CPU/RAM/disk, Postgres connections and HTTP 5xx rate say nothing about freshness. When a CPO disputes a penalty, there is no evidence either way, and no way to tell "vendor feed silent" from "our pipeline stuck".
- **Fix.**
  - Freshness SLIs split by owner: vendor lag (event → receipt), platform latency (receipt → committed → pushed → rendered), and inbox backlog age.
  - Per-tenant SLO reports and multi-window burn-rate alerts.
  - One "vendor feed degraded" alert instead of thousands of "charger offline" alerts.

### H9. Map and tile serving (§5)
- **Problem.**
  - The browser re-downloads the full GeoJSON `FeatureCollection` every 10 s: about 12,000 features, several MB per client per refresh.
  - Tiles query the same tables the consumers write to, on every refresh.
  - The 10 s poll alone uses most of the map's "< 10 s P95" budget, before any pipeline latency.
- **Fix.**
  - Send an initial snapshot, then push status changes (WebSocket or SSE).
  - Tiles from pre-aggregated live state, not ad-hoc SQL.
  - Vector tiles and clustering for the static site layer; MapLibre GL instead of thousands of Leaflet DOM markers.

---

## Medium

| ID | Finding | Fix |
|---|---|---|
| M1 | Login sessions live in a single Redis (§8): a restart logs out every user of every tenant | Stateless tokens from Keycloak (short-lived access token + refresh); Redis only for rebuildable cache |
| M2 | A session whose `session.stop` never arrives is never billed or flagged (§7): silent revenue leak | Sweeper moves open sessions past a cut-off to review; reconcile open sessions against the poll API |
| M3 | Units and tariffs (§7): Wh → kWh not mentioned, no tariff versioning (a mid-day price change), no rounding rule | Rate with the tariff in force at session start; NUMERIC; stated rounding; keep the tariff ID on each charge |
| M4 | Timestamps arrive with charger-local offsets (§4.2): offsets aren't zones, so daily rollups mis-bucket | Store UTC instants; keep the original string; zone-aware rollups; reject timestamps from the future (bad charger clocks) |
| M5 | No data residency or privacy design (§2, §11): Indian and German data in one unspecified place | Regional deployments (India cell, EU cell); DR inside the same jurisdiction; data inventory for DPDP / GDPR |
| M6 | Keycloak HA unaddressed; ingestion edge and poller in one NestJS service (§2) | Keycloak clustered; split webhook edge (latency-critical, stateless) from pollers (I/O-bound, leased) |
| M7 | The open questions (§13) miss the real ones: vendor latency, rate-limit scope, geocoding, residency, what settlement legally is | Replace with the list below |

---

## What the draft gets right

- **Kafka keyed by `charger_id`:** per-charger ordering within a partition and horizontal scaling of consumers. Keep it, but don't rely on it for correctness (H1).
- **Consumers split by concern** (status, sessions, settlement): a good seam for scaling and ownership.
- **Keycloak / OAuth2, not home-grown auth,** and TLS everywhere.
- **Prometheus and Grafana as the stack:** the right tools, aimed at the wrong signals (H8).
- **One database engine family keeps operations simple.** With TimescaleDB and PostGIS, Postgres can carry this load (C4, H5, H6); the problem is how it is used, not the choice.
- **Tariff details are flagged as an open question** instead of being invented.

## Questions to settle before sign-off

1. **Freshness contract.** Is each KPI measured from the charger's event time, the vendor's send time, or our receipt? Who carries vendor-caused breaches?
2. **Vendor feed.**
   - Is the 30 s poll limit per site or per account, and does a pagination request count?
   - Does `since` filter on event time or vendor ingestion time?
   - How far back can we re-poll after an outage?
   - Can webhook batching be shortened, and can meter values come by webhook?
3. **Webhook details.** HMAC encoding (hex or base64), any timestamp or replay window, and the redelivery retry horizon.
4. **Identifiers.** Is `session_id` unique per vendor, per CPO, or globally? Are charger IDs unique across vendors?
5. **Catalogue.** The poll API needs a `site_id`, but there is no site-list endpoint. Where do sites, addresses and connector lists come from, and how are changes notified?
6. **Settlement.**
   - Is it the legal invoice or a reconciliation ledger?
   - Which time defines the business day (start or stop)?
   - Taxes, rounding, and treatment of zero-energy sessions.
   - Is foreign exchange ever involved?
7. **Retention.** How long raw telemetry must be kept, as opposed to rollups and invoices (Germany 8–10 years for accounting records, India about 6).
8. **Residency.** Must Indian and German data stay in-country or in-region, including backups and DR?
9. **Scale assumptions.** Connectors per charger, meter cadence when idle, and peak concurrent dashboard users.

## If only three things change before the client sees it

1. Tenant from token plus row-level security (C1).
2. Idempotent, local-day, versioned settlement with meter-reset handling (C2, C6).
3. Rewrite the freshness section to state what the interface allows and what we will measure and commit to, with re-done sizing and HA numbers (C3, C4, C5).
