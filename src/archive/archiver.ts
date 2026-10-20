import type { S3Client } from '@aws-sdk/client-s3';
import type { Pool } from '../db/pool.js';
import { metrics } from '../observability/metrics.js';
import { putRawObject } from './aws.js';

// Copies processed raw payloads to object storage, off the apply path: an S3
// outage delays archiving but never ingestion. The archive is the audit trail
// for billing disputes and the source for replays.
export async function archiveProcessed(pool: Pool, s3: S3Client, bucket: string, limit = 50): Promise<number> {
  const { rows } = await pool.query<{
    inbox_id: number;
    connection_id: string;
    source: string;
    received_at: Date;
    payload: unknown;
  }>(
    `SELECT inbox_id, connection_id, source, received_at, payload FROM csms_inbox
      WHERE processed_at IS NOT NULL AND archived_at IS NULL
      ORDER BY inbox_id LIMIT $1`,
    [limit],
  );
  let done = 0;
  for (const row of rows) {
    const d = row.received_at.toISOString();
    const key = `raw/${row.source}/${row.connection_id}/${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}/${row.inbox_id}.json`;
    try {
      await putRawObject(s3, bucket, key, JSON.stringify(row.payload));
      await pool.query(`UPDATE csms_inbox SET archived_at = now() WHERE inbox_id = $1`, [row.inbox_id]);
      metrics.archived.inc({ result: 'ok' });
      done += 1;
    } catch (err) {
      metrics.archived.inc({ result: 'error' });
      console.error(`archive of inbox ${row.inbox_id} failed: ${(err as Error).message}`);
      break; // storage is unhappy: try again on the next tick
    }
  }
  return done;
}
