import { describe, expect, it } from 'vitest';
import { evaluateSessionEnergy, type SessionFacts } from '../../src/billing/energy.js';

const opts = { tolerance: 1.1, resetMaxGapSec: 120 };
const t = (s: string) => new Date(s);

describe('session energy from a lifetime register', () => {
  it('sess-de-99x: plain register delta, 41.420 kWh in 34 min on a 150 kW charger', () => {
    const v = evaluateSessionEnergy(
      {
        startedAt: t('2026-06-09T22:41:03+02:00'),
        stoppedAt: t('2026-06-09T23:14:58+02:00'),
        startMeterWh: 9_930_120,
        stopMeterWh: 9_971_540,
        maxKw: 150,
      },
      [],
      opts,
    );
    expect(v).toMatchObject({ kind: 'billable', energyWh: 41_420, method: 'register_delta' });
  });

  it('sess-in-44a: 11.667 kWh in 7 min 19 s is ~96 kW on a 60 kW charger, so it is held', () => {
    const v = evaluateSessionEnergy(
      {
        startedAt: t('2026-06-09T14:25:02+05:30'),
        stoppedAt: t('2026-06-09T14:32:21+05:30'),
        startMeterWh: 4_810_000,
        stopMeterWh: 4_821_667,
        maxKw: 60,
      },
      [],
      opts,
    );
    expect(v.kind).toBe('review');
    if (v.kind === 'review') {
      expect(v.reason).toBe('implausible_energy');
      expect(v.detail).toContain('96 kW');
    }
  });

  it('a stop that arrives before its start waits for the start (duration needed for the check)', () => {
    const v = evaluateSessionEnergy(
      { startedAt: null, stoppedAt: t('2026-06-09T14:32:21+05:30'), startMeterWh: 4_810_000, stopMeterWh: 4_821_667, maxKw: 60 },
      [],
      opts,
    );
    expect(v).toEqual({ kind: 'incomplete', waitingFor: 'start' });
  });

  it('sess-in-77c: stop register below start (meter reset), no readings: never negative, held', () => {
    const v = evaluateSessionEnergy(
      { startedAt: null, stoppedAt: t('2026-06-09T18:40:12+05:30'), startMeterWh: 12_044_990, stopMeterWh: 31_200, maxKw: 22 },
      [],
      opts,
    );
    expect(v.kind).toBe('review');
    if (v.kind === 'review') expect(v.reason).toBe('meter_reset');
  });

  const resetSession: SessionFacts = {
    startedAt: t('2026-06-09T18:00:00+05:30'),
    stoppedAt: t('2026-06-09T18:40:12+05:30'),
    startMeterWh: 12_044_990,
    stopMeterWh: 9_000,
    maxKw: 22,
  };

  it('rebuilds energy across a reset when readings bracket it closely', () => {
    const v = evaluateSessionEnergy(
      resetSession,
      [
        { ts: t('2026-06-09T18:10:00+05:30'), energyWh: 12_047_990 }, // +3,000
        { ts: t('2026-06-09T18:10:30+05:30'), energyWh: 500 }, // reset: +500 since 0, gap 30 s
        { ts: t('2026-06-09T18:30:00+05:30'), energyWh: 6_500 }, // +6,000
      ], // stop 9,000: +2,500
      opts,
    );
    expect(v).toMatchObject({ kind: 'billable', energyWh: 12_000, method: 'reset_reconstructed' });
  });

  it('does not rebuild when the readings around the reset are too far apart', () => {
    const v = evaluateSessionEnergy(
      resetSession,
      [
        { ts: t('2026-06-09T18:05:00+05:30'), energyWh: 12_046_000 },
        { ts: t('2026-06-09T18:30:00+05:30'), energyWh: 6_500 }, // 25 min gap across the reset
      ],
      opts,
    );
    expect(v.kind).toBe('review');
    if (v.kind === 'review') expect(v.reason).toBe('meter_reset');
  });
});
