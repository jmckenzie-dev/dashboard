import * as client from 'prom-client';

export const registry = new client.Registry();

// Collect default Node.js/process metrics as well
client.collectDefaultMetrics({ register: registry });

export const pollDuration = new client.Histogram({
  name: 'dashboard_poll_duration_seconds',
  help: 'Duration of dashboard polling steps in seconds',
  labelNames: ['step'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const partCacheHits = new client.Counter({
  name: 'dashboard_part_cache_hits_total',
  help: 'Total number of parsed part cache hits or misses',
  labelNames: ['result'],
  registers: [registry],
});

export const sseClientsActive = new client.Gauge({
  name: 'dashboard_sse_clients_active',
  help: 'Number of active SSE client connections',
  registers: [registry],
});

export const sessionsTotal = new client.Gauge({
  name: 'dashboard_sessions_total',
  help: 'Total number of sessions by status',
  labelNames: ['status'],
  registers: [registry],
});

export const snapshotDuration = new client.Histogram({
  name: 'dashboard_snapshot_duration_seconds',
  help: 'Duration of the shared snapshot poll cycle in seconds',
  labelNames: ['phase'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const snapshotSubscribers = new client.Gauge({
  name: 'dashboard_snapshot_subscribers',
  help: 'Number of SSE clients subscribed to the shared snapshot',
  registers: [registry],
});

export const snapshotSkipped = new client.Counter({
  name: 'dashboard_snapshot_skipped_total',
  help: 'Number of snapshot ticks skipped because a previous tick was still running',
  registers: [registry],
});
