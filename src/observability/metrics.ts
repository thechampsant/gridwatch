import http from 'node:http';
import client from 'prom-client';

// One registry per process. The SLIs that matter for the freshness contract:
//   gridwatch_source_lag_seconds       vendor-attributable: how old an event
//                                      already was when it reached us
//   gridwatch_pipeline_latency_seconds platform-attributable: receipt to
//                                      committed state
//   gridwatch_inbox_oldest_pending_age_seconds  backlog, the leading indicator
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const metrics = {
  events: new client.Counter({
    name: 'gridwatch_events_total',
    help: 'Events processed, by outcome',
    labelNames: ['source', 'type', 'outcome'] as const,
    registers: [registry],
  }),
  quarantined: new client.Counter({
    name: 'gridwatch_quarantined_total',
    help: 'Events or payloads sent to the dead-letter store, by reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  sourceLag: new client.Histogram({
    name: 'gridwatch_source_lag_seconds',
    help: 'Vendor-attributable lag: poll = server_time - event ts; webhook = receipt - event ts',
    labelNames: ['source', 'type'] as const,
    buckets: [1, 2, 5, 10, 15, 30, 45, 60, 90, 120, 300, 900, 3600, 86400],
    registers: [registry],
  }),
  pipelineLatency: new client.Histogram({
    name: 'gridwatch_pipeline_latency_seconds',
    help: 'Platform-attributable latency: receipt to committed state',
    labelNames: ['type'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 5, 10, 30],
    registers: [registry],
  }),
  inboxOldestPendingAge: new client.Gauge({
    name: 'gridwatch_inbox_oldest_pending_age_seconds',
    help: 'Age of the oldest unprocessed inbox row (0 when empty)',
    registers: [registry],
  }),
  csmsRequests: new client.Counter({
    name: 'gridwatch_csms_requests_total',
    help: 'Poll requests to the vendor CSMS, by outcome',
    labelNames: ['outcome'] as const,
    registers: [registry],
  }),
  pollCycles: new client.Counter({
    name: 'gridwatch_poll_cycles_total',
    help: 'Completed poll cycles, by result',
    labelNames: ['result'] as const,
    registers: [registry],
  }),
  webhookDeliveries: new client.Counter({
    name: 'gridwatch_webhook_deliveries_total',
    help: 'Webhook deliveries received, by result',
    labelNames: ['result'] as const,
    registers: [registry],
  }),
  reconciliationMissed: new client.Counter({
    name: 'gridwatch_reconciliation_missed_events_total',
    help: 'Events first seen on a deep reconciliation poll (i.e. missed by the normal path)',
    registers: [registry],
  }),
  archived: new client.Counter({
    name: 'gridwatch_raw_archive_total',
    help: 'Raw payloads archived to object storage, by result',
    labelNames: ['result'] as const,
    registers: [registry],
  }),
};

export function startMetricsServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('content-type', registry.contentType);
      res.end(await registry.metrics());
      return;
    }
    if (req.url === '/healthz') {
      res.end('ok');
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(port);
  return server;
}
