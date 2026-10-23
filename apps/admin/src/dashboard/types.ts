import type { AdminApi, UploadApi } from '@internal/web-kit';

// Derived from the API client so the app needs no direct @internal/contracts dependency.
export type TourSummary = Awaited<ReturnType<AdminApi['listTours']>>['tours'][number];
export type PanoSummary = Awaited<ReturnType<AdminApi['listPanos']>>['panos'][number];
export type Visibility = NonNullable<TourSummary['publish']>['visibility'];
/** What the owner holds against the upload limits; a null limit means none is set. */
export type Usage = Awaited<ReturnType<UploadApi['getUsage']>>;
export type SharedTourSummary = Awaited<ReturnType<AdminApi['listSharedTours']>>['tours'][number];
