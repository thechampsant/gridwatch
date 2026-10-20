// Injectable clock. Stub payloads are dated June 2026, so freshness queries
// take an explicit "as of" time instead of reading the wall clock directly.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(at: Date | string): Clock {
  const d = typeof at === 'string' ? new Date(at) : at;
  return { now: () => new Date(d.getTime()) };
}

export function parseAsOf(raw: unknown, fallback: Date): Date {
  if (typeof raw !== 'string' || raw === '') return fallback;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid as_of: ${raw}`);
  return d;
}
