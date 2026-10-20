# Questions for the client and assumptions made

The brief invites either a sharp question or a defensible assumption. These are the questions I would send, each with the assumption I built on while waiting for an answer.

| # | Question | Assumption used | What changes if the answer differs |
|---|---|---|---|
| Q1 | Is each freshness KPI measured from the charger event, the vendor's send, or GridWatch receipt? Who carries breaches caused by vendor batching? | Receipt to screen is ours; vendor lag is reported separately | If end-to-end: the KPIs can't be met through this interface (Part A §8) and need vendor changes |
| Q2 | Can the vendor send status and faults without batching, and meter values by webhook (or offer a stream)? | No: webhooks are batched up to 60 s; meter values come by poll only | A better feed lowers the vendor floor; the architecture doesn't change |
| Q3 | Is the 30 s poll limit per site or per account? Do pagination requests count? | Per site; pagination doesn't count | If pagination counts, catch-up after an outage takes about 22 min per site (Part A §10) |
| Q4 | Does `since` filter on event time or on the vendor's ingestion time? How far back can we re-poll? | Unknown, so we re-ask with a 5 min overlap and run hourly 2 h reconciliation | Event-time `since` would miss events that arrive late at the vendor unless the overlap covers them |
| Q5 | Webhook signature: hex or base64? Any timestamp or replay window? How long does the vendor keep redelivering? | Accept hex and base64; replays are harmless (idempotent) | A replay window would be added at the edge |
| Q6 | Is `session_id` unique per vendor, per CPO, or globally? Are charger IDs unique across vendors? | Session unique per connection; charger IDs unique within GridWatch | Namespacing at onboarding if not |
| Q7 | The poll API needs a `site_id`, but nothing lists sites. Where do sites, addresses and connector lists come from? | Loaded at CPO onboarding (here: from the pilot dataset) | A vendor catalogue endpoint would be polled daily |
| Q8 | Is GridWatch's settlement the legal invoice to drivers or a reconciliation ledger for the CPO? | Reconciliation ledger | Legal invoicing adds tax, invoice numbering, legal retention and, for German driver billing, calibration-law-compliant signed meter data |
| Q9 | Which time defines a session's business day: start or stop? Whose timezone? | Stop time, in the site's IANA zone | One-line change in rating; statements re-issued |
| Q10 | Tariffs: currency, time-of-day pricing, idle fees, taxes, rounding, zero-energy sessions? Any foreign exchange? | Per-kWh price + session fee in local currency; half-up rounding to 2 decimals; tax excluded; no FX | Rating module changes; schema already versions tariffs |
| Q11 | Is a held session (meter reset, implausible energy) acceptable, rather than invoicing and correcting later? Who at the CPO may decide a held session? | Hold for review; any operator user may decide in the slice | Bill-then-credit would need a credit-note flow. Production gives the decision to a reviewer role in Keycloak |
| Q12 | Data residency: must Indian and German data (including backups and DR) stay in-country or in-region? | Yes: one cell per region, DR in the same jurisdiction | A single region would simplify operations |
| Q13 | Retention: raw telemetry versus rollups versus settlement records? | Raw 90 days, rollups 3 years, settlement 8–10 years | Storage sizing (Part A §10) |
| Q14 | Connectors per charger, and do chargers send meter values when idle? | 1.5 per charger (pilot ratio), sized for 2; meter values every 10 s always (worst case) | Sizing scales linearly |
| Q15 | Who uses "nearest available charger": operators, support agents, field staff, or a driver app? | Operators and support staff, via the dashboard API | A driver-facing use needs a public, rate-limited, cached endpoint |
| Q16 | The pilot dataset mentions a "starter kit" mock CSMS with all 50 sites. It wasn't included. Is there one? | No: the 3-site excerpt was expanded with clearly labelled synthetic sites | Swap the seed |

## Data-quality findings in the provided material

These were found while building against the stubs. They are worth raising with the vendor, not just handling.

- **`sess-in-44a` is physically implausible.** 11.667 kWh between 14:25:02 and 14:32:21 is about 96 kW average on a 60 kW charger, while the same connector's readings at 14:32 show about 41 kW. Either the start register or the start time is wrong. GridWatch holds it for review.
- **`sess-in-77c`** has a stop register below its start register (a meter reset) and no start event. If the reset coincided with the 18:02:40 GroundFailure, the post-reset 31.2 kWh by 18:40:12 would be about 50 kW on a 22 kW AC charger, so even a "lower bound" invoice is suspect. GridWatch holds it.
- **Stub 1e** contains a meter value with `energy_register_wh: null` and a status event with no connector or status. Each is quarantined on its own; the rest of the page is still applied.
- **No site has coordinates.** The pilot data carries addresses only, and some (such as "Metro Station, Gate 3") would defeat most geocoders. Coordinates: none come from Cidroy's data. 3 site pins and 21 postal-code centres were entered by hand as approximate stand-ins for an operations pin, a geocoder cache and a postal dataset. They are not verified positions.
- **Poll pages are not time-ordered** (1b's fault at 14:30:55 is older than 1a's events), and the cursor is an offset (`{"offset":50}`) over a changing set. Hence the overlap window and reconciliation.
