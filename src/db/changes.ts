// "Something changed for this operator": the signal the API pushes to open
// dashboards. It carries IDs only, never data; a screen that hears it
// re-reads through the normal API, where row-level security applies.
//
// Sent with pg_notify inside the writer's transaction, so it is delivered
// only if the change commits (and dropped with a rolled-back savepoint).

export const CHANGES_CHANNEL = 'gridwatch_changes';

export type ChangeKind = 'status' | 'meter' | 'fault' | 'session' | 'statement' | 'site';

export interface Change {
  id: number | null; // inbox row, when the change came from the vendor
  op: string; // operator the change belongs to
  sites: string[];
  kinds: ChangeKind[];
  receivedAt: string | null; // when GridWatch received the vendor payload
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export async function notifyChange(c: Queryable, change: Change): Promise<void> {
  // NOTIFY payloads are capped near 8 kB; a change never needs to name more than a few sites.
  const payload = JSON.stringify({ ...change, sites: change.sites.slice(0, 50) });
  await c.query(`SELECT pg_notify($1, $2)`, [CHANGES_CHANNEL, payload]);
}

export function kindOfEvent(type: string): ChangeKind {
  if (type === 'meter_value') return 'meter';
  if (type === 'fault') return 'fault';
  if (type.startsWith('session')) return 'session';
  return 'status';
}
