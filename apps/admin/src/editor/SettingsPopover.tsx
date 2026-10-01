import type { TourSettings } from '@internal/contracts';
import { Segmented } from '@internal/ui';
import { useEffect, useRef } from 'react';

export interface SettingsPopoverProps {
  settings: TourSettings;
  onChange: (patch: Partial<TourSettings>) => void;
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
export function SettingsPopover({ settings, onChange, onClose }: SettingsPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
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
