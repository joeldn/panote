import {
  ANALYTICS_SCHEMA_VERSION,
  MAX_DWELL_MS,
  type AnalyticsEventType,
  type AnalyticsSurface,
} from '@internal/contracts';
import { readJsonBody, type BodyResult } from '@internal/worker-kit';

// Beacon bodies are tiny; anything bigger than this is not ours.
export const MAX_BODY_BYTES = 8 * 1024;

export interface AnalyticsPoint {
  type: 'view' | AnalyticsEventType;
  panoId?: string | undefined;
  hotspotId?: string | undefined;
  ms?: number | undefined;
  surface?: AnalyticsSurface | undefined;
}

export const clampDwell = (ms: number): number => Math.min(MAX_DWELL_MS, Math.max(0, ms));

// The documented AE schema (docs/wave6-plan.md 3.3). Content ids only: no IP,
// UA, country, referrer, client id or sub ever goes in here.
export const toDataPoint = (tourId: string, p: AnalyticsPoint): AnalyticsEngineDataPoint => ({
  indexes: [tourId],
  blobs: [p.type, p.panoId ?? '', p.hotspotId ?? '', p.surface ?? 'page', ANALYTICS_SCHEMA_VERSION],
  doubles: [p.type === 'dwell' ? clampDwell(p.ms ?? 0) : 0],
});

// Reads the body as text whatever the content-type, since sendBeacon sends strings as
// text/plain, and stops reading past MAX_BODY_BYTES (worker-kit's body.ts). An empty
// body is treated as `{}`.
export const readBeaconBody = (req: Request): Promise<BodyResult> =>
  readJsonBody(req, MAX_BODY_BYTES);
