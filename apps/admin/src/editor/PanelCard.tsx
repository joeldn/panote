import { cx } from '@internal/ui';
import { useId, type ReactNode } from 'react';

import { PANEL_LABELS, usePanelOpen, usePanelSheet, type PanelKey } from './panels.js';

export interface PanelCardProps {
  panel: PanelKey;
  /** After the title, in the heading: a count or a short state. */
  count?: ReactNode;
  /** Controls that stay in the head whether the card is open or folded. */
  actions?: ReactNode;
  /** Under the head, shown folded or open: what mustn't hide with the body (an error). */
  notice?: ReactNode;
  className?: string;
  /** Called with the new state when the head opens or folds the card. */
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}

/**
 * One of the editor's side cards. Wide, its head opens and folds it (remembered per
 * browser); on a phone it is one tab of the panel sheet and always shows whole.
 */
export function PanelCard({
  panel,
  count,
  actions,
  notice,
  className,
  onToggle,
  children,
}: PanelCardProps) {
  const [open, toggle] = usePanelOpen(panel);
  const sheet = usePanelSheet();
  const titleId = useId();
  const bodyId = useId();
  const label = PANEL_LABELS[panel];
  const showing = sheet ? sheet.active === panel : open;

  return (
    <section
      className={cx('ed-card', className, !showing && 'ed-card--folded')}
      {...(sheet
        ? {
            role: 'tabpanel',
            id: `${sheet.idPrefix}-panel-${panel}`,
            'aria-labelledby': `${sheet.idPrefix}-tab-${panel}`,
            hidden: !showing,
          }
        : { 'aria-labelledby': titleId })}
    >
      <header className="ed-card__head">
        <h2 id={titleId} className="ed-card__title">
          {sheet ? (
            <>
              {label} {count}
            </>
          ) : (
            <button
              type="button"
              className="ed-card__toggle"
              aria-expanded={open}
              aria-controls={open ? bodyId : undefined}
              onClick={() => {
                toggle();
                onToggle?.(!open);
              }}
            >
              {label} {count}
              <i className="fa-solid fa-chevron-right ed-card__chevron" aria-hidden="true" />
            </button>
          )}
        </h2>
        {actions && <div className="ed-card__actions">{actions}</div>}
      </header>
      {notice}
      {showing && (
        <div id={bodyId} className="ed-card__body">
          {children}
        </div>
      )}
    </section>
  );
}
