import type { AdminApi } from '@internal/web-kit';

// Derived from the API client so the app needs no direct @internal/contracts dependency.
export type TourSummary = Awaited<ReturnType<AdminApi['listTours']>>['tours'][number];
export type PanoSummary = Awaited<ReturnType<AdminApi['listPanos']>>['panos'][number];
export type Visibility = NonNullable<TourSummary['publish']>['visibility'];
