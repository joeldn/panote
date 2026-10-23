import {
  MAX_OPS_DETAIL_LENGTH,
  OPS_EVENTS_SCHEMA_VERSION,
  type OpsEventName,
} from '@internal/contracts';

// Writes one operator event (@internal/contracts ops-events.ts) to a Worker's OPS_EVENTS
// Analytics Engine binding. Structural, like RateLimiter, so node tests can pass a fake;
// the generated AnalyticsEngineDataset satisfies it.
export interface OpsEventSink {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export interface OpsEvent {
  event: OpsEventName;
  detail?: string;
  value?: number;
}

/**
 * Records `e` from `service`. Never throws and never waits: a missing binding (a test,
 * an env without it) or a failed write only loses the data point, never the request.
 * Layout: index1 = event, blob1 = event, blob2 = detail, blob3 = service, blob4 = schema
 * version, double1 = value.
 */
export const recordOps = (sink: OpsEventSink | undefined, service: string, e: OpsEvent): void => {
  if (!sink) return;
  const value = e.value !== undefined && Number.isFinite(e.value) ? e.value : 0;
  try {
    sink.writeDataPoint({
      indexes: [e.event],
      blobs: [
        e.event,
        (e.detail ?? '').slice(0, MAX_OPS_DETAIL_LENGTH),
        service,
        OPS_EVENTS_SCHEMA_VERSION,
      ],
      doubles: [value],
    });
  } catch (err) {
    console.error('ops event not written:', err instanceof Error ? err.name : 'unknown error');
  }
};
