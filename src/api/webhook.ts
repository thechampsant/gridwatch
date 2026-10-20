import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import type { SecretProvider } from '../archive/aws.js';
import { verifySignature } from '../csms/signature.js';
import { metrics } from '../observability/metrics.js';

// Webhook receiver. The vendor redelivers the whole batch if we are slow or
// return an error, so this does the minimum: verify the HMAC over the raw
// bytes, append the batch to the durable inbox, answer 202. All parsing of
// events happens later in the processor. If the inbox write fails we answer
// 503: the vendor's at-least-once redelivery then works in our favour.
export function registerWebhook(app: FastifyInstance, deps: { ingestPool: Pool; secrets: SecretProvider }) {
  app.register(async (scope) => {
    // Raw body as a Buffer: the signature is over the exact bytes received,
    // so the JSON must not be parsed and re-serialised first.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => {
      done(null, body);
    });

    scope.post<{ Params: { connectionId: string } }>('/webhooks/csms/:connectionId', async (req, reply) => {
      const started = new Date();
      const { connectionId } = req.params;
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const record = (status: number, outcome: string, handling: string, deliveryId: string | null) =>
        deps.ingestPool
          .query(
            `INSERT INTO csms_calls (direction, connection_id, request, status_code, outcome, handling, started_at, duration_ms)
             VALUES ('webhook', $1, $2, $3, $4, $5, $6, $7)`,
            [
              connectionId,
              `POST /webhooks/csms/${connectionId}${deliveryId ? ` (${deliveryId})` : ''}`,
              status,
              outcome,
              handling,
              started,
              Date.now() - started.getTime(),
            ],
          )
          .catch((err) => req.log.error({ err }, 'failed to record webhook call'));

      const conn = (
        await deps.ingestPool.query<{ webhook_secret_ref: string }>(
          `SELECT webhook_secret_ref FROM csms_connections WHERE connection_id = $1`,
          [connectionId],
        )
      ).rows[0];
      if (!conn) return reply.code(404).send({ error: 'unknown connection' });

      const header = req.headers['x-csms-signature'];
      const secrets = await deps.secrets.get(conn.webhook_secret_ref);
      if (!verifySignature(body, Array.isArray(header) ? header[0] : header, secrets)) {
        metrics.webhookDeliveries.inc({ result: 'bad_signature' });
        await record(401, 'bad_signature', 'Signature check failed: rejected, nothing stored.', null);
        return reply.code(401).send({ error: 'invalid signature' });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        // Signed by the vendor but not JSON. Redelivery would never fix it, so
        // acknowledge, keep the bytes in dead-letter and alert on the counter.
        await deps.ingestPool.query(
          `INSERT INTO quarantine (connection_id, raw_text, reason, detail) VALUES ($1, $2, 'invalid_json', 'webhook body is not JSON')`,
          [connectionId, body.toString('utf8').slice(0, 100_000)],
        );
        metrics.webhookDeliveries.inc({ result: 'quarantined' });
        await record(202, 'quarantined', 'Signed but not JSON: acknowledged (redelivery cannot fix it) and kept in dead-letter.', null);
        return reply.code(202).send({ accepted: false, quarantined: true });
      }

      const deliveryId =
        typeof payload === 'object' && payload !== null && typeof (payload as { delivery_id?: unknown }).delivery_id === 'string'
          ? (payload as { delivery_id: string }).delivery_id
          : null;

      try {
        const inboxId = await withTx(deps.ingestPool, async (c) => {
          const r = await c.query<{ inbox_id: number }>(
            `INSERT INTO csms_inbox (connection_id, source, delivery_ref, payload)
             VALUES ($1, 'webhook', $2, $3) RETURNING inbox_id`,
            [connectionId, deliveryId, JSON.stringify(payload)],
          );
          const id = r.rows[0]!.inbox_id;
          await c.query(`SELECT pg_notify('csms_inbox', $1)`, [String(id)]);
          return id;
        });
        metrics.webhookDeliveries.inc({ result: 'accepted' });
        await record(202, 'accepted', 'X-CSMS-Signature HMAC checked, then acknowledged only after a durable write.', deliveryId);
        return reply.code(202).send({ accepted: true, inbox_id: inboxId });
      } catch (err) {
        req.log.error({ err }, 'inbox write failed');
        metrics.webhookDeliveries.inc({ result: 'store_failed' });
        return reply.code(503).send({ error: 'temporarily unavailable, please redeliver' });
      }
    });
  });
}
