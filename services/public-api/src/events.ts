import {
  ANALYTICS_SCHEMA_VERSION,
  MAX_DWELL_MS,
  type AnalyticsEventType,
  type AnalyticsSurface,
} from '@internal/contracts';

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

export type BodyResult = { ok: true; value: unknown } | { ok: false; status: 400 | 413 };

// Reads the body as text whatever the content-type, since sendBeacon sends
// strings as text/plain. An empty body is treated as `{}`.
export const readJsonBody = async (req: Request): Promise<BodyResult> => {
  // Reject by header before buffering; the post-read check covers chunked bodies.
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return { ok: false, status: 413 };
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413 };
  }
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
};
