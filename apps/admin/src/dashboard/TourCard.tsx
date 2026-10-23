import type { TourSummary, Visibility } from './types.js';
import { Chip, shareUrl, useCopy, VISIBILITY_META, type CopyState } from '@internal/ui';
import { useState } from 'react';
import { Link } from 'react-router';

import { CardMenu, type CardMenuItem } from './CardMenu.js';
import { coverStyle, fallbackHue, type Cover } from './cover.js';
import { writeCurrentTour } from './current-tour.js';
import { formatCount, plural, relativeTime } from './format.js';

/** What only the owner may do to a tour. */
export interface OwnerActions {
  onVisibility(tour: TourSummary, visibility: Visibility): Promise<void>;
  onDuplicate(tour: TourSummary): Promise<void>;
  onDelete(tour: TourSummary): void;
}

export interface TourCardProps {
  tour: TourSummary;
  cover: Cover | null;
  /** Absent while loading, null when stats are unavailable. */
  views: number | null | undefined;
  current: boolean;
  now: number;
  /** The public site's origin, for the share link (`VITE_SITE_ORIGIN`). */
  siteOrigin: string;
  /** The owner's controls. Absent on a tour someone shared with this account. */
  owner?: OwnerActions;
  /** On a tour someone shared with this account: whose it is (null when unknown). */
  ownerEmail?: string | null;
  /** Kept on the insights link, so closing it comes back to the same filter. */
  search?: string;
}

const COPY_LABEL: Record<CopyState, string> = {
  idle: 'Copy link',
  copied: 'Copied',
  failed: 'Couldn’t copy',
};
const COPY_SAID: Record<CopyState, string> = {
  idle: '',
  copied: 'Copied ✓',
  failed: 'Couldn’t copy. Open the tour and copy it from Share.',
};
const COPY_ICON: Record<CopyState, string> = {
  idle: 'fa-solid fa-link',
  copied: 'fa-solid fa-check',
  failed: 'fa-solid fa-triangle-exclamation',
};

const NEXT: Record<Visibility, Visibility> = { public: 'unlisted', unlisted: 'public' };

/** Who can see it: a label, changed from the card's menu. */
function VisibilityChip({ tour }: { tour: TourSummary }) {
  if (!tour.publish) {
    return (
      <Chip className="dash-card__vis" icon="fa-solid fa-pen">
        Draft
      </Chip>
    );
  }
  const meta = VISIBILITY_META[tour.publish.visibility];
  return (
    <Chip className="dash-card__vis" icon={meta.icon}>
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
  owner,
  ownerEmail,
  search = '',
}: TourCardProps) {
  const [visPending, setVisPending] = useState(false);
  const [copied, copy] = useCopy();
  const live = tour.publish ? shareUrl(siteOrigin, tour.publish.slug) : null;
  const [duplicating, setDuplicating] = useState(false);
  const insightsTo = `/insights/${tour.tourId}${search}`;

  const viewsLabel =
    views === undefined
      ? '… views'
      : views === null
        ? '– views'
        : `${formatCount(views)} view${views === 1 ? '' : 's'}`;

  const items: CardMenuItem[] = [];
  if (live)
    items.push({ label: 'Open live', icon: 'fa-solid fa-arrow-up-right-from-square', href: live });
  items.push({ label: 'Insights', icon: 'fa-solid fa-chart-line', to: insightsTo });
  if (owner) {
    if (tour.publish) {
      const next = NEXT[tour.publish.visibility];
      items.push({
        label: `Make ${VISIBILITY_META[next].label.toLowerCase()}`,
        icon: VISIBILITY_META[next].icon,
        disabled: visPending,
        onSelect: () => {
          setVisPending(true);
          void owner.onVisibility(tour, next).finally(() => setVisPending(false));
        },
      });
    }
    items.push(
      {
        label: 'Duplicate',
        icon: 'fa-solid fa-clone',
        disabled: duplicating,
        onSelect: () => {
          setDuplicating(true);
          void owner.onDuplicate(tour).finally(() => setDuplicating(false));
        },
      },
      {
        label: 'Delete',
        icon: 'fa-solid fa-trash-can',
        danger: true,
        onSelect: () => owner.onDelete(tour),
      },
    );
  }

  const when = relativeTime(tour.updatedAt, now);

  return (
    <article className="dash-card">
      <div className="dash-card__cover">
        <CoverImage tour={tour} cover={cover} />
        <div className="dash-card__scrim" />
        <VisibilityChip tour={tour} />
        {current && (
          <Chip className="dash-card__current" tone="accent" mono>
            Current
          </Chip>
        )}
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
          {plural(tour.sceneCount, 'pano')} ·{' '}
          <Link className="dash-card__views" to={insightsTo}>
            {viewsLabel}
          </Link>
        </p>
        <div className="dash-card__foot">
          <span className="dash-card__updated">
            {owner ? `Updated ${when}` : `${ownerEmail ?? 'Shared with you'} · updated ${when}`}
          </span>
          <div className="dash-card__actions">
            {live && (
              <button
                type="button"
                className="dash-card__copy"
                aria-label={`Copy link to “${tour.title}”`}
                title={copied === 'failed' ? COPY_SAID.failed : undefined}
                onClick={() => void copy(live)}
              >
                <i className={COPY_ICON[copied]} aria-hidden="true" />
                {COPY_LABEL[copied]}
              </button>
            )}
            {/* Beside the button, not in it: its aria-label would hide what this says. */}
            {live && (
              <span className="dash-card__sr" role="status">
                {COPY_SAID[copied]}
              </span>
            )}
            <CardMenu
              label={`More for “${tour.title}”`}
              items={items}
              busy={duplicating || visPending}
            />
          </div>
        </div>
      </div>
    </article>
  );
}
