import { useRef, type KeyboardEvent, type ReactNode } from 'react';

import { cx } from './cx.js';

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string | number> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  'aria-label': string;
  /** `tabs` for view switchers (share modal), `radio` for a value choice (embed height). */
  kind?: 'radio' | 'tabs';
  /** For `tabs`: id prefix; each tab controls `${idPrefix}-panel-${value}`. */
  idPrefix?: string;
  className?: string;
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  kind = 'radio',
  idPrefix,
  className,
  'aria-label': ariaLabel,
}: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const pos = enabled.indexOf(index);
    let next: number | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = enabled[(pos + 1) % enabled.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = enabled[(pos - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    const option = next === undefined ? undefined : options[next];
    if (next === undefined || !option) return;
    e.preventDefault();
    onChange(option.value);
    refs.current[next]?.focus();
  };

  const tabs = kind === 'tabs';
  return (
    <div
      role={tabs ? 'tablist' : 'radiogroup'}
      aria-label={ariaLabel}
      className={cx('pn-seg', className)}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        const id = idPrefix ? `${idPrefix}-tab-${String(o.value)}` : undefined;
        return (
          <button
            key={String(o.value)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={id}
            type="button"
            role={tabs ? 'tab' : 'radio'}
            aria-checked={tabs ? undefined : selected}
            aria-selected={tabs ? selected : undefined}
            aria-controls={tabs && idPrefix ? `${idPrefix}-panel-${String(o.value)}` : undefined}
            tabIndex={selected ? 0 : -1}
            disabled={o.disabled}
            className="pn-seg__opt"
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
