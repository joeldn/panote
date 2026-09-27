import { cx } from './cx.js';

const TEARDROP =
  'M16 2.4 C9.4 2.4 4.3 7.4 4.3 13.7 C4.3 21 13.4 28.6 16 30 C18.6 28.6 27.7 21 27.7 13.7 C27.7 7.4 22.6 2.4 16 2.4 Z';

export interface LogoMarkProps {
  /** Pixel size of the square mark (nav uses 24). */
  size?: number;
  /** Fill colour; follows the `--accent` token by default. */
  accent?: string;
  className?: string;
}

/** The "pin-horizon" mark: a white-bordered pin holding a horizon and a viewpoint. */
export function LogoMark({ size = 24, accent = 'var(--accent)', className }: LogoMarkProps) {
  return (
    <svg
      className={cx('pn-logo__mark', className)}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={TEARDROP}
        fill={accent}
        stroke="#fff"
        strokeWidth={3}
        strokeLinejoin="round"
        style={{ paintOrder: 'stroke' }}
      />
      <circle cx={16} cy={13.4} r={6.4} fill="none" stroke="#fff" strokeWidth={1.5} />
      <path
        d="M10.2 14.8 Q16 11.4 21.8 14.8"
        stroke="#fff"
        strokeWidth={1.5}
        fill="none"
        strokeLinecap="round"
      />
      <circle cx={18.4} cy={10.6} r={1.5} fill="#fff" />
    </svg>
  );
}

export interface LogoProps extends LogoMarkProps {
  /** Wordmark text next to the mark; `false` for the mark alone. */
  wordmark?: string | false;
}

export function Logo({ wordmark = 'panote.io', className, ...mark }: LogoProps) {
  return (
    <span className={cx('pn-logo', className)} aria-label={wordmark || 'panote'} role="img">
      <LogoMark {...mark} />
      {wordmark && (
        <span className="pn-logo__word" aria-hidden="true">
          {wordmark}
        </span>
      )}
    </span>
  );
}
