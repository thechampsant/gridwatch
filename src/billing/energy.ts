// Session energy from a cumulative lifetime register (Wh).
//
// Rules, in order:
//   1. Normal case: energy = stop register - start register.
//   2. Register went down (reset or meter swap): rebuild from interval readings,
//      but only when readings bracket the reset closely; otherwise hold.
//   3. Plausibility: energy may not exceed max_kw x duration x tolerance.
// A session is never billed a negative or physically impossible amount; when
// in doubt it is held for review, not guessed.

export interface SessionFacts {
  startedAt: Date | null;
  stoppedAt: Date | null;
  startMeterWh: number | null;
  stopMeterWh: number | null;
  maxKw: number;
}

export interface Reading {
  ts: Date;
  energyWh: number;
}

export interface EnergyOptions {
  tolerance: number; // e.g. 1.1
  resetMaxGapSec: number; // readings must bracket a reset within this gap
}

export type EnergyVerdict =
  | { kind: 'incomplete'; waitingFor: 'start' | 'stop' }
  | { kind: 'billable'; energyWh: number; method: 'register_delta' | 'reset_reconstructed'; note: string }
  | {
      kind: 'review';
      reason: 'meter_reset' | 'implausible_energy' | 'invalid_duration';
      detail: string;
      lowerBoundWh?: number;
    };

export function evaluateSessionEnergy(f: SessionFacts, readings: Reading[], opts: EnergyOptions): EnergyVerdict {
  if (f.stopMeterWh === null || f.stoppedAt === null) return { kind: 'incomplete', waitingFor: 'stop' };
  if (f.startMeterWh === null) return { kind: 'incomplete', waitingFor: 'start' };

  const delta = f.stopMeterWh - f.startMeterWh;

  if (delta < 0) {
    if (f.startedAt === null) {
      return {
        kind: 'review',
        reason: 'meter_reset',
        detail: `Stop register (${fmtWh(f.stopMeterWh)}) is below start register (${fmtWh(f.startMeterWh)}): meter reset or replacement. No start time, so interval readings can't be matched. Not invoiced.`,
      };
    }
    const rebuilt = reconstructAcrossReset(f, readings, opts.resetMaxGapSec);
    if (rebuilt.kind === 'unbracketed') {
      return {
        kind: 'review',
        reason: 'meter_reset',
        detail: `Stop register is below start register: meter reset. ${rebuilt.why} Not invoiced.`,
      };
    }
    const implausible = plausibility(f, rebuilt.energyWh, opts.tolerance);
    if (implausible) return implausible;
    return {
      kind: 'billable',
      energyWh: rebuilt.energyWh,
      method: 'reset_reconstructed',
      note: `Meter reset inside the session; rebuilt from ${rebuilt.readingsUsed} interval readings: ${fmtKwh(rebuilt.energyWh)}.`,
    };
  }

  if (f.startedAt === null) return { kind: 'incomplete', waitingFor: 'start' };

  const implausible = plausibility(f, delta, opts.tolerance);
  if (implausible) return implausible;
  return { kind: 'billable', energyWh: delta, method: 'register_delta', note: `Settled once: ${fmtKwh(delta)}.` };
}

function plausibility(f: SessionFacts, energyWh: number, tolerance: number): EnergyVerdict | null {
  if (f.startedAt === null || f.stoppedAt === null) return null;
  const durationMs = f.stoppedAt.getTime() - f.startedAt.getTime();
  if (durationMs <= 0) {
    return {
      kind: 'review',
      reason: 'invalid_duration',
      detail: `Stop time is not after start time (${fmtDuration(durationMs)}). Not invoiced.`,
    };
  }
  const hours = durationMs / 3_600_000;
  const maxWh = f.maxKw * 1000 * hours * tolerance;
  if (energyWh > maxWh) {
    const avgKw = energyWh / 1000 / hours;
    return {
      kind: 'review',
      reason: 'implausible_energy',
      detail: `${fmtKwh(energyWh)} in ${fmtDuration(durationMs)} is about ${Math.round(avgKw)} kW average on a ${trimKw(f.maxKw)} kW charger (limit ${fmtKwh(Math.floor(f.maxKw * 1000 * hours))}). Held for review, not invoiced.`,
    };
  }
  return null;
}

type Rebuild =
  | { kind: 'ok'; energyWh: number; readingsUsed: number }
  | { kind: 'unbracketed'; why: string };

// Walk start register -> interval readings -> stop register. Positive steps
// are energy; a negative step is a reset, after which the new register value
// is energy since the reset (registers restart at 0). Energy delivered between
// the last reading before the reset and the reset itself is unknown, so the
// two readings around it must be close together.
export function reconstructAcrossReset(f: SessionFacts, readings: Reading[], maxGapSec: number): Rebuild {
  if (f.startedAt === null || f.stoppedAt === null || f.startMeterWh === null || f.stopMeterWh === null) {
    return { kind: 'unbracketed', why: 'Session window is incomplete.' };
  }
  const start = f.startedAt.getTime();
  const stop = f.stoppedAt.getTime();
  const inside = readings
    .filter((r) => r.ts.getTime() > start && r.ts.getTime() < stop)
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  if (inside.length === 0) {
    return { kind: 'unbracketed', why: 'No interval readings inside the session to rebuild from.' };
  }
  const series: Reading[] = [
    { ts: f.startedAt, energyWh: f.startMeterWh },
    ...inside,
    { ts: f.stoppedAt, energyWh: f.stopMeterWh },
  ];
  let total = 0;
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!;
    const cur = series[i]!;
    const step = cur.energyWh - prev.energyWh;
    if (step >= 0) {
      total += step;
      continue;
    }
    const gapSec = (cur.ts.getTime() - prev.ts.getTime()) / 1000;
    if (gapSec > maxGapSec) {
      return {
        kind: 'unbracketed',
        why: `The nearest readings around the reset are ${Math.round(gapSec)} s apart (limit ${maxGapSec} s), so unmetered energy can't be bounded.`,
      };
    }
    total += cur.energyWh;
  }
  return { kind: 'ok', energyWh: total, readingsUsed: inside.length };
}

export function fmtKwh(wh: number): string {
  return `${(wh / 1000).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kWh`;
}

export function fmtWh(wh: number): string {
  return `${wh.toLocaleString('en-US')} Wh`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  const sign = ms < 0 ? '-' : '';
  if (s < 60) return `${sign}${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${sign}${m} min ${rest} s`;
  return `${sign}${Math.floor(m / 60)} h ${m % 60} min`;
}

function trimKw(kw: number): string {
  return Number.isInteger(kw) ? String(kw) : kw.toFixed(1);
}
