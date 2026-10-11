import { MAX_TOUR_DESCRIPTION_LENGTH, type TourSettings } from '@internal/contracts';
import { Segmented } from '@internal/ui';
import { useEffect, useId, useRef, useState } from 'react';

export interface SettingsPopoverProps {
  settings: TourSettings;
  /** The tour's stored (trimmed) description, '' when it has none. */
  description: string;
  onChange: (patch: Partial<TourSettings>) => void;
  /** Every edit, untrimmed; the editor stores it trimmed. */
  onDescription: (text: string) => void;
  onClose: () => void;
}

const TOGGLES: Array<{
  key: 'showMap' | 'showCompass' | 'autoRotate';
  label: string;
  hint: string;
}> = [
  { key: 'showMap', label: 'Mini-map', hint: 'Floor plan in the corner' },
  { key: 'showCompass', label: 'Compass', hint: 'Points to each pano’s north' },
  { key: 'autoRotate', label: 'Auto-rotate', hint: 'Slowly pans when idle' },
];

/** Tour-wide viewer settings: 300px glass popover under the top bar's gear. */
export function SettingsPopover({
  settings,
  description,
  onChange,
  onDescription,
  onClose,
}: SettingsPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  // What's being typed, so a trailing space survives until blur; null shows the stored value.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? description;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (
        ref.current &&
        target &&
        !ref.current.contains(target) &&
        !target.closest('[data-settings-toggle]')
      ) {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="ed-popover" role="dialog" aria-label="Tour settings">
      <h2 className="ed-popover__title">Tour settings</h2>
      <div className="ed-field ed-popover__description">
        <label className="ed-label" htmlFor={`${id}-description`}>
          Description
        </label>
        <textarea
          id={`${id}-description`}
          className="ed-input ed-textarea"
          value={text}
          maxLength={MAX_TOUR_DESCRIPTION_LENGTH}
          rows={3}
          aria-describedby={`${id}-description-hint ${id}-description-count`}
          onChange={(e) => {
            setDraft(e.target.value);
            onDescription(e.target.value);
          }}
          onBlur={() => setDraft(null)}
        />
        <div className="ed-popover__meta">
          <span id={`${id}-description-hint`}>
            Shown in link previews. The first 160 or so characters show in search results.
          </span>
          <span id={`${id}-description-count`} className="ed-popover__count">
            {text.length} / {MAX_TOUR_DESCRIPTION_LENGTH}
          </span>
        </div>
      </div>
      <div className="ed-field">
        <span className="ed-label" id="ed-controls-label">
          Controls
        </span>
        <Segmented
          aria-label="Control placement"
          options={[
            { value: 'bottom', label: 'Bottom' },
            { value: 'top', label: 'Top' },
          ]}
          value={settings.controls}
          onChange={(controls) => onChange({ controls })}
        />
      </div>
      {TOGGLES.map(({ key, label, hint }) => (
        <label key={key} className="ed-toggle">
          <span>
            <span className="ed-toggle__label">{label}</span>
            <span className="ed-toggle__hint">{hint}</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={settings[key]}
            onChange={(e) => onChange({ [key]: e.target.checked })}
          />
        </label>
      ))}
    </div>
  );
}
