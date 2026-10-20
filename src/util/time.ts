// Offsets are not timezones: Germany is +01:00 or +02:00 depending on DST.
// Everything is stored as UTC instants; IANA zones are used only to display
// and to decide business days.

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(date);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// 2026-06-09T23:14:58+02:00 style, in the given zone.
export function formatOffsetIso(date: Date, timeZone: string): string {
  const off = tzOffsetMinutes(date, timeZone);
  const local = new Date(date.getTime() + off * 60_000);
  const abs = Math.abs(off);
  return `${local.toISOString().slice(0, 19)}${off < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// 14:33:40, wall-clock time in the given zone.
export function formatLocalTime(date: Date, timeZone: string): string {
  return formatOffsetIso(date, timeZone).slice(11, 19);
}

export function secondsBetween(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / 1000;
}
