#!/usr/bin/env bash
# Walks through the slice against a running stack (`docker compose up`).
# Needs only docker and curl on the host: JSON is formatted inside the api container.
set -euo pipefail
cd "$(dirname "$0")/.."

API=${API:-http://localhost:8080}
FAKE=${FAKE:-http://localhost:8090}

js() { docker compose exec -T api node -e "$1"; }
title() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
token() { curl -sf -X POST "$API/dev/token" -H 'content-type: application/json' -d "{\"as\":\"$1\"}" | js 'console.log(JSON.parse(require("fs").readFileSync(0)).token)'; }

title "Waiting for the fake vendor to finish its scripted scenario (1-2 minutes after start-up)"
# Done when the webhooks are in, the GroundFailure page has been served, and
# S-IN-0007 has been polled again after its scripted 429.
for _ in $(seq 1 60); do
  health=$(curl -sf "$FAKE/healthz" || true)
  if echo "$health" | grep -q '"s12FaultServed":true' && echo "$health" | grep -q '"s7PolledAfter429":true'; then
    echo "scenario complete"; sleep 3; break
  fi
  sleep 5
done

ACME=$(token acme-charge)
STADTWERKE=$(token stadtwerke-ev)
ADMIN=$(token platform_admin)

title "Ingestion log (pilot sites): what happened to every stub event, and why"
curl -sf -H "authorization: Bearer $ADMIN" "$API/v1/ingestion/events" | js '
const d = JSON.parse(require("fs").readFileSync(0));
console.log("outcomes:", JSON.stringify(d.counts));
d.events.forEach((e, i) => console.log(
  String(i + 1).padStart(2), e.sourceLabel.padEnd(26), e.summary.slice(0, 36).padEnd(37),
  ((e.charger_id || "") + "/" + (e.connector_id || "?")).padEnd(14), e.outcome.padEnd(11), e.reason.slice(0, 90)));'

title "Tenant isolation: Acme token asking for ?operator_id=stadtwerke-ev"
curl -sf -H "authorization: Bearer $ACME" "$API/v1/sites/status?operator_id=stadtwerke-ev" | js '
const d = JSON.parse(require("fs").readFileSync(0));
const age = s => s === null ? "never" : s < 120 ? s + " s ago" : s < 7200 ? Math.round(s / 60) + " min ago" : Math.round(s / 86400) + " days ago";
console.log("operators visible:", [...new Set(d.sites.map(s => s.operatorId))].join(", "), "| totals:", JSON.stringify(d.totals));
for (const s of d.sites.filter(s => !s.synthetic)) console.log(" ", s.siteId, s.rollup.padEnd(9), "geocode:", s.geocode.precision + "/" + s.geocode.source,
  "| last contact:", s.lastContact.via, age(s.lastContact.ageSec), "|", s.connectors.map(c => c.chargerId + "/" + c.connectorId + "=" + c.status).join(" "));'

title "Nearest available charger from Noida Sector 62 (Acme)"
curl -sf -H "authorization: Bearer $ACME" "$API/v1/chargers/nearest?lat=28.628&lng=77.3649&limit=3" | js '
const d = JSON.parse(require("fs").readFileSync(0));
console.log("rule:", d.rule);
d.results.forEach(r => console.log(" ", r.distanceKm.toFixed(2), "km", r.siteId, r.name, "| pin precision:", r.geocodePrecision, "| available:", r.available.map(a => a.chargerId + "/" + a.connectorId).join(", ")));
d.skippedCloser.forEach(s => console.log("  skipped", s.siteId, s.distanceKm, "km:", s.reason));'

title "Sessions and charges (platform admin)"
curl -sf -H "authorization: Bearer $ADMIN" "$API/v1/sessions?date=2026-06-09" | js '
const d = JSON.parse(require("fs").readFileSync(0));
d.sessions.forEach(s => console.log(" ", s.session_id.padEnd(12), s.billing_status.padEnd(13), (s.review_reason || "").padEnd(19),
  s.total_amount ? s.total_amount + " " + s.currency + " (" + s.energy_wh + " Wh, day " + s.business_date + ")" : (s.review_detail || "").slice(0, 80)));'

title "Stadtwerke cannot see Acme sessions"
curl -sf -H "authorization: Bearer $STADTWERKE" "$API/v1/sessions" | js '
console.log(" ", JSON.parse(require("fs").readFileSync(0)).sessions.map(s => s.session_id).join(", "));'

title "Daily settlement for 9 June 2026, per operator, on its own local day"
# Settlement waits for a watermark: every site must have been polled past the
# end of that local day. Right after start-up one site may still be waiting
# out a scripted 429, so this retries until the data is in.
for _ in $(seq 1 12); do
  out=$(docker compose exec -T api node dist/bin/settle.js --date 2026-06-09)
  echo "$out"
  echo "$out" | grep -q '"not_ready"' || break
  echo "  (not ready yet: waiting 10 s for the watermark)"
  sleep 10
done
docker compose exec -T api node dist/bin/settle.js --date 2026-06-09 | sed 's/^/re-run: /'

title "Freshness: vendor share vs. GridWatch share"
curl -sf -H "authorization: Bearer $ADMIN" "$API/v1/freshness" | js '
const d = JSON.parse(require("fs").readFileSync(0));
const p = d.platform;
console.log("  platform (receipt -> committed): p50", p.p50Sec?.toFixed(3), "s, p99.9", p.p999Sec?.toFixed(3), "s over", p.events, "events");
d.signals.forEach(s => console.log(" ", s.signal.padEnd(32), ("target " + s.targetSec + " s " + s.percentile).padEnd(18), s.verdict.padEnd(17),
  s.vendorAgeWhenServed ? "vendor age when served: " + s.vendorAgeWhenServed.minSec + "-" + s.vendorAgeWhenServed.maxSec + " s" : ""));'

title "Vendor calls (platform admin): 429, 500 and how they were handled"
curl -sf -H "authorization: Bearer $ADMIN" "$API/v1/admin/csms-calls" | js '
const d = JSON.parse(require("fs").readFileSync(0));
d.calls.filter(c => /S-IN-0007|S-DE-0003|webhook/.test(c.request + c.direction)).slice(0, 12).forEach(c =>
  console.log(" ", String(c.status_code ?? "-").padEnd(4), c.request.slice(0, 70).padEnd(71), c.handling.slice(0, 80)));'

title "Infrastructure provisioned by Terraform in LocalStack"
echo "  raw payloads archived to S3: $(docker compose exec -T localstack awslocal s3 ls s3://gridwatch-raw-archive-local --recursive | wc -l | tr -d ' ')"
echo "  secrets: $(docker compose exec -T localstack awslocal secretsmanager list-secrets --query 'SecretList[].Name' --output text)"

title "Done. Dashboard: $API/dashboard   Prometheus: http://localhost:9090"
