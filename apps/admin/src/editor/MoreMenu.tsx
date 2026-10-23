import { Link } from 'react-router';

import { useMenu } from './use-menu.js';

export interface MoreMenuProps {
  /** The language being edited, as its tag (`en`). */
  lang: string;
  langName: string;
  peopleTo: string;
  insightsTo: string;
  onLanguages: () => void;
  onSettings: () => void;
}

/**
 * The top bar's menu: what a tour needs now and then (its settings, languages, people and
 * insights), so the bar itself keeps to Preview, Save and Share.
 */
export function MoreMenu({
  lang,
  langName,
  peopleTo,
  insightsTo,
  onLanguages,
  onSettings,
}: MoreMenuProps) {
  const { open, close, rootProps, buttonProps, menuProps } = useMenu();

  return (
    <div {...rootProps} className="ed-more">
      <button
        {...buttonProps}
        type="button"
        className="ed-glass-btn ed-glass-btn--icon"
        aria-label="Tour menu"
        // Picking a popover from here mustn't count as a click outside it.
        data-settings-toggle
        data-languages-toggle
      >
        <i className="fa-solid fa-ellipsis" aria-hidden="true" />
      </button>
      {open && (
        <div {...menuProps} className="ed-more__menu" aria-label="Tour menu">
          <button
            type="button"
            role="menuitem"
            className="ed-more__item"
            data-settings-toggle
            onClick={() => {
              close(false);
              onSettings();
            }}
          >
            <i className="fa-solid fa-sliders" aria-hidden="true" />
            Tour settings
          </button>
          <button
            type="button"
            role="menuitem"
            className="ed-more__item"
            data-languages-toggle
            aria-label={`Languages, editing ${langName}`}
            onClick={() => {
              close(false);
              onLanguages();
            }}
          >
            <i className="fa-solid fa-globe" aria-hidden="true" />
            Languages
            <span className="ed-more__tag">{lang}</span>
          </button>
          <Link
            role="menuitem"
            className="ed-more__item"
            to={peopleTo}
            onClick={() => close(false)}
          >
            <i className="fa-solid fa-user-group" aria-hidden="true" />
            People
          </Link>
          <Link
            role="menuitem"
            className="ed-more__item"
            to={insightsTo}
            onClick={() => close(false)}
          >
            <i className="fa-solid fa-chart-line" aria-hidden="true" />
            Insights
          </Link>
        </div>
      )}
    </div>
  );
}
