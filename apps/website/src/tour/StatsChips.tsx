import type { TourStatsState } from './use-stats.js';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** View count and the like button beside the breadcrumb (screen 05). */
export function StatsChips({ stats, liked, like }: TourStatsState) {
  return (
    <div className="tour-stats">
      <span className="tour-chip" aria-label={stats ? `${stats.views} views` : 'Views'}>
        <i className="fa-solid fa-chart-line" aria-hidden="true" />
        <span className="tour-chip__num">
          {stats ? compact.format(stats.views).toLowerCase() : '–'}
        </span>
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
