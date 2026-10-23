import type { TourSummary, Visibility } from './types.js';
import { Chip, shareUrl, useCopy, VISIBILITY_META, type CopyState } from '@internal/ui';
import { useState } from 'react';
import { Link } from 'react-router';

import { coverStyle, fallbackHue, type Cover } from './cover.js';
import { writeCurrentTour } from './current-tour.js';
import { formatCount, plural, relativeTime } from './format.js';
import { SHARED_PANOS_NOTE } from './use-dashboard.js';

export interface TourCardProps {
  tour: TourSummary;
  cover: Cover | null;
  /** Absent while loading, null when stats are unavailable. */
  views: number | null | undefined;
  current: boolean;
  now: number;
  /** The public site's origin, for the share link (`VITE_SITE_ORIGIN`). */
  siteOrigin: string;
  onVisibility(tour: TourSummary, visibility: Visibility): Promise<void>;
  onDuplicate(tour: TourSummary): Promise<void>;
  onDelete(tour: TourSummary): void;
}

const COPY_TITLE: Record<CopyState, string> = {
  idle: 'Copy link',
  copied: 'Copied ✓',
  failed: 'Couldn’t copy. Open the tour and copy it from Share.',
};
const COPY_ICON: Record<CopyState, string> = {
  idle: 'fa-solid fa-link',
  copied: 'fa-solid fa-check',
  failed: 'fa-solid fa-triangle-exclamation',
};

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

function CoverImage({ tour, cover }: { tour: TourSummary; cover: Cover | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (cover && cover.src !== failed) {
    return (
      <img
        className="dash-card__img"
        src={cover.src}
        style={coverStyle(cover)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(cover.src)}
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
  cover,
  views,
  current,
  now,
  siteOrigin,
  onVisibility,
  onDuplicate,
  onDelete,
}: TourCardProps) {
  const [visPending, setVisPending] = useState(false);
  const [copied, copy] = useCopy();
  const live = tour.publish ? shareUrl(siteOrigin, tour.publish.slug) : null;
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
        <CoverImage tour={tour} cover={cover} />
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
            {live && (
              <a
                className="dash-card__action"
                href={live}
                target="_blank"
                rel="noopener"
                title="View live"
                aria-label={`View “${tour.title}” live`}
              >
                <i className="fa-solid fa-arrow-up-right-from-square" aria-hidden="true" />
              </a>
            )}
            {live && (
              <button
                type="button"
                className="dash-card__action"
                title={COPY_TITLE[copied]}
                aria-label={`Copy the link to “${tour.title}”`}
                onClick={() => void copy(live)}
              >
                <i className={COPY_ICON[copied]} aria-hidden="true" />
              </button>
            )}
            {/* Beside the button, not in it: its aria-label would hide what this says. */}
            {live && (
              <span className="dash-card__sr" role="status">
                {copied === 'idle' ? '' : COPY_TITLE[copied]}
              </span>
            )}
            <Link
              className="dash-card__action"
              to={`/insights/${tour.tourId}`}
              title="Insights"
              aria-label={`Insights for “${tour.title}”`}
            >
              <i className="fa-solid fa-chart-line" aria-hidden="true" />
            </Link>
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
