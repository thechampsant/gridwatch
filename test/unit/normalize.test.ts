import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../../src/ingest/normalize.js';
import { STUBS, stub } from '../helpers/fixtures.js';

describe('normalising vendor events', () => {
  it('turns charger-local timestamps into UTC instants, keeping the original string', () => {
    const [status] = stub(STUBS.page1).events;
    const r = normalizeEvent(status);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.ts.toISOString()).toBe('2026-06-09T09:02:11.000Z'); // 14:32:11+05:30
    expect(r.event.tsRaw).toBe('2026-06-09T14:32:11+05:30');

    const [, stop] = stub(STUBS.webhookNormal).events;
    const s = normalizeEvent(stop);
    expect(s.ok && s.event.ts.toISOString()).toBe('2026-06-09T21:14:58.000Z'); // 23:14:58+02:00 (CEST)
  });

  it('rejects each malformed event in stub 1e on its own, with a reason', () => {
    const [nullEnergy, missingFields] = stub(STUBS.malformed).events;

    const a = normalizeEvent(nullEnergy);
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.reason).toBe('malformed_event');
      expect(a.detail).toContain('energy_register_wh');
      expect(a.partial.chargerId).toBe('C-DE-0003-A'); // still attributable for the ingestion log
    }

    const b = normalizeEvent(missingFields);
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.detail).toContain('connector_id');
      expect(b.detail).toContain('status');
    }
  });

  it('rejects timestamps without an offset: local time without a zone is ambiguous', () => {
    const r = normalizeEvent({ type: 'status', charger_id: 'C-1', connector_id: '1', status: 'Available', ts: '2026-06-09T14:32:11' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown event types and statuses instead of guessing', () => {
    expect(normalizeEvent({ type: 'heartbeat' }).ok).toBe(false);
    expect(
      normalizeEvent({ type: 'status', charger_id: 'C-1', connector_id: '1', status: 'Broken', ts: '2026-06-09T14:32:11Z' }).ok,
    ).toBe(false);
  });
});
