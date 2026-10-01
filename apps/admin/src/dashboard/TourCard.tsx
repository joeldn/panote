import type { TourSummary, Visibility } from './types.js';
import { Chip, VISIBILITY_META } from '@internal/ui';
import { useState } from 'react';
import { Link } from 'react-router';

import { fallbackHue } from './cover.js';
import { writeCurrentTour } from './current-tour.js';
import { formatCount, plural, relativeTime } from './format.js';
import { SHARED_PANOS_NOTE } from './use-dashboard.js';

export interface TourCardProps {
  tour: TourSummary;
  coverSrc: string | null;
  /** Absent while loading, null when stats are unavailable. */
  views: number | null | undefined;
  current: boolean;
  now: number;
  onVisibility(tour: TourSummary, visibility: Visibility): Promise<void>;
  onDuplicate(tour: TourSummary): Promise<void>;
  onDelete(tour: TourSummary): void;
}

const NEXT: Record<Visibility, Visibility> = { public: 'unlisted', unlisted: 'public' };

function VisibilityChip({
  tour,
  pending,
  onToggle,
}: {
  tour: TourSummary;
  pending: boolean;
  onToggle(v: Visibility): void;
}) {
  if (!tour.publish) {
    return (
      <Chip
        className="dash-card__vis"
        icon="fa-solid fa-pen"
        title="Not shared yet. Save it in the editor to get a link."
      >
        Draft
      </Chip>
    );
  }
  const current = tour.publish.visibility;
  const meta = VISIBILITY_META[current];
  const next = NEXT[current];
  return (
    <Chip
      className="dash-card__vis"
      icon={meta.icon}
      title={`Click to make it ${VISIBILITY_META[next].label}`}
      aria-label={`${meta.label}. Make “${tour.title}” ${VISIBILITY_META[next].label}`}
      onClick={pending ? () => {} : () => onToggle(next)}
    >
      {meta.label}
    </Chip>
  );
}

function Cover({ tour, src }: { tour: TourSummary; src: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (src && src !== failed) {
    return (
      <img
        className="dash-card__img"
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(src)}
      />
    );
  }
  const hue = fallbackHue(tour.tourId);
  return (
    <div
      className="dash-card__fallback"
      data-testid="cover-fallback"
      style={{
        background: `linear-gradient(160deg, hsl(${hue} 32% 40%), hsl(${(hue + 12) % 360} 26% 18%))`,
      }}
    >
      <i className="fa-solid fa-panorama" aria-hidden="true" />
    </div>
  );
}

export function TourCard({
  tour,
  coverSrc,
  views,
  current,
  now,
  onVisibility,
  onDuplicate,
  onDelete,
}: TourCardProps) {
  const [visPending, setVisPending] = useState(false);
  const [duplicating, setDuplicating] = useState(false);

  const toggle = (v: Visibility) => {
    setVisPending(true);
    void onVisibility(tour, v).finally(() => setVisPending(false));
  };
  const duplicate = () => {
    if (duplicating) return;
    setDuplicating(true);
    void onDuplicate(tour).finally(() => setDuplicating(false));
  };
  const viewsLabel =
    views === undefined
      ? '… views'
      : views === null
        ? '– views'
        : `${formatCount(views)} view${views === 1 ? '' : 's'}`;

  return (
    <article className="dash-card">
      <div className="dash-card__cover">
        <Cover tour={tour} src={coverSrc} />
        <div className="dash-card__scrim" />
        <VisibilityChip tour={tour} pending={visPending} onToggle={toggle} />
        {current && (
          <Chip className="dash-card__current" tone="accent" mono>
            Current
          </Chip>
        )}
        <span className="dash-card__badge">
          <i className="fa-solid fa-panorama" aria-hidden="true" />
          360°
        </span>
      </div>
      <div className="dash-card__body">
        <h2 className="dash-card__title">
          <Link
            className="dash-card__link"
            to={`/t/${tour.tourId}`}
            onClick={() => writeCurrentTour(tour.tourId)}
          >
            {tour.title}
          </Link>
        </h2>
        <p className="dash-card__meta">
          {plural(tour.sceneCount, 'pano')} · {viewsLabel}
        </p>
        <div className="dash-card__foot">
          <span className="dash-card__updated">Updated {relativeTime(tour.updatedAt, now)}</span>
          <div className="dash-card__actions">
            <button
              type="button"
              className="dash-card__action"
              title={`Duplicate. ${SHARED_PANOS_NOTE}`}
              aria-label={`Duplicate “${tour.title}”`}
              aria-busy={duplicating || undefined}
              disabled={duplicating}
              onClick={duplicate}
            >
              <i
                className={duplicating ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-clone'}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              className="dash-card__action dash-card__action--danger"
              title="Delete"
              aria-label={`Delete “${tour.title}”`}
              onClick={() => onDelete(tour)}
            >
              <i className="fa-solid fa-trash-can" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
