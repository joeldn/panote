import type { TourStatsState } from './use-stats.js';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en');

/** View count and the like button beside the breadcrumb (screen 05). */
export function StatsChips({ stats, liked, like }: TourStatsState) {
  return (
    <div className="tour-stats">
      {/* aria-label on a plain span is ignored, so the count is read from hidden text. */}
      <span className="tour-chip">
        <i className="fa-solid fa-chart-line" aria-hidden="true" />
        <span className="tour-chip__num" aria-hidden="true">
          {stats ? compact.format(stats.views).toLowerCase() : '–'}
        </span>
        <span className="pn-sr-only">{stats ? `${full.format(stats.views)} views` : 'Views'}</span>
      </span>
      <button
        type="button"
        className="tour-chip tour-chip--like"
        aria-pressed={liked}
        aria-label={liked ? 'Liked' : 'Like this tour'}
        onClick={like}
      >
        <i className="fa-solid fa-heart" aria-hidden="true" />
        <span className="tour-chip__num">
          {stats ? compact.format(stats.likes).toLowerCase() : ''}
        </span>
      </button>
    </div>
  );
}
