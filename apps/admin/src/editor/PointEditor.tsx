import { MAX_HOTSPOT_BODY_LENGTH, MAX_TITLE_LENGTH, type Hotspot } from '@internal/contracts';
import { Button, FALLBACK_ICON, pointIcon, Segmented } from '@internal/ui';
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { searchIcons } from './icons.js';
import { applyFormat, formatForKey, IS_MAC, type MarkdownFormat } from './markdown-format.js';
import { POINT_SIZE_MAX, POINT_SIZE_MIN, POINT_SIZE_STEP, type HotspotPatch } from './model.js';
import { isCdnMedia, mediaInput, parseMedia, type MediaKind } from './media.js';

type MediaChoice = 'none' | MediaKind;

const MEDIA_OPTIONS: Array<{ value: MediaChoice; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
  { value: 'youtube', label: 'YouTube' },
];

// Letters rather than icons for the text styles: the icon subset has none for them.
const FORMATS: Array<{ format: MarkdownFormat; label: string; glyph: ReactNode; keys: string }> = [
  { format: 'bold', label: 'Bold', glyph: <b>B</b>, keys: 'B' },
  { format: 'italic', label: 'Italic', glyph: <em>I</em>, keys: 'I' },
  { format: 'heading', label: 'Heading', glyph: <b>H</b>, keys: 'Alt+2' },
  {
    format: 'link',
    label: 'Link',
    glyph: <i className="fa-solid fa-link" aria-hidden="true" />,
    keys: 'K',
  },
];

const MEDIA_PLACEHOLDER: Record<MediaKind, string> = {
  image: 'https://cdn.panote.dev/…/photo.jpg',
  video: 'https://cdn.panote.dev/…/clip.mp4',
  youtube: 'https://youtu.be/… or video id',
};

export interface PointEditorProps {
  point: Hotspot;
  cdnBase: string;
  onChange: (patch: HotspotPatch) => void;
  /** Turn the view to face the point (while sizing it). */
  onFace: () => void;
  /** Start (or, while `moving`, cancel) moving the point to a new spot on the pano. */
  onMove: () => void;
  moving: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
  onDone: () => void;
}

type FieldProps = Pick<PointEditorProps, 'point' | 'onChange'>;

/** The markdown body, with a toolbar (and its shortcuts) for the syntax the viewer renders. */
function BodyField({ point, onChange }: FieldProps) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  // Where the selection goes once the formatted text has rendered.
  const selectAfter = useRef<[number, number] | null>(null);
  const body = point.body ?? '';

  useLayoutEffect(() => {
    const sel = selectAfter.current;
    if (!sel || !area.current) return;
    selectAfter.current = null;
    area.current.setSelectionRange(sel[0], sel[1]);
  }, [body]);

  const format = (f: MarkdownFormat) => {
    const el = area.current;
    if (!el) return;
    const next = applyFormat(
      { value: el.value, start: el.selectionStart, end: el.selectionEnd },
      f,
    );
    el.focus();
    if (next.value.length > MAX_HOTSPOT_BODY_LENGTH) return;
    selectAfter.current = [next.start, next.end];
    onChange({ body: next.value ? next.value : null });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const f = formatForKey(e);
    if (!f) return;
    e.preventDefault();
    format(f);
  };

  return (
    <div className="ed-field">
      <label className="ed-label" htmlFor={`${id}-body`}>
        Text <span className="ed-label__hint">markdown</span>
      </label>
      <div className="ed-format" role="group" aria-label="Formatting">
        {FORMATS.map(({ format: f, label, glyph, keys }) => (
          <button
            key={f}
            type="button"
            className="ed-format__btn"
            aria-label={label}
            title={`${label} (${IS_MAC ? `⌘+${keys.replace('Alt', '⌥')}` : `Ctrl+${keys}`})`}
            aria-keyshortcuts={`${IS_MAC ? 'Meta' : 'Control'}+${keys}`}
            // Keep the textarea's selection: format it, don't blur it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format(f)}
          >
            {glyph}
          </button>
        ))}
      </div>
      <textarea
        ref={area}
        id={`${id}-body`}
        className="ed-input ed-textarea"
        value={body}
        maxLength={MAX_HOTSPOT_BODY_LENGTH}
        rows={4}
        onKeyDown={onKeyDown}
        onChange={(e) => onChange({ body: e.target.value ? e.target.value : null })}
      />
    </div>
  );
}

function MediaField({ point, cdnBase, onChange }: FieldProps & Pick<PointEditorProps, 'cdnBase'>) {
  const id = useId();
  const stored = point.media;
  const [kind, setKind] = useState<MediaChoice>(stored?.kind ?? 'none');
  const [text, setText] = useState(stored ? mediaInput(stored) : '');
  const [error, setError] = useState<string | null>(null);

  const commit = (k: MediaChoice, value: string) => {
    if (k === 'none') {
      setError(null);
      onChange({ media: null });
      return;
    }
    if (!value.trim()) {
      setError(null);
      onChange({ media: null });
      return;
    }
    const parsed = parseMedia(k, value);
    if (parsed.ok) {
      setError(null);
      onChange({ media: parsed.media });
    } else {
      setError(parsed.message);
    }
  };

  const offCdn = stored && !isCdnMedia(stored, cdnBase);
  return (
    <fieldset className="ed-field ed-media">
      <legend className="ed-label">Media</legend>
      <Segmented
        aria-label="Media type"
        options={MEDIA_OPTIONS}
        value={kind}
        onChange={(k) => {
          setKind(k);
          commit(k, text);
        }}
      />
      {kind !== 'none' && (
        <>
          <label className="ed-sr" htmlFor={`${id}-url`}>
            {kind === 'youtube' ? 'YouTube link or id' : 'Media link'}
          </label>
          <input
            id={`${id}-url`}
            className="ed-input"
            value={text}
            placeholder={MEDIA_PLACEHOLDER[kind]}
            inputMode="url"
            onChange={(e) => setText(e.target.value)}
            onBlur={() => commit(kind, text)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(kind, text);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error || offCdn ? `${id}-note` : undefined}
          />
        </>
      )}
      {error ? (
        <p id={`${id}-note`} className="ed-note ed-note--error" role="alert">
          {error}
        </p>
      ) : (
        offCdn &&
        kind !== 'none' && (
          <p id={`${id}-note`} className="ed-note ed-note--warn" role="status">
            <i className="fa-solid fa-triangle-exclamation" aria-hidden="true" /> This link isn’t on
            the panote CDN, so visitors see it as a plain link instead of inline.
          </p>
        )
      )}
    </fieldset>
  );
}

/** The selected point's panel: title, markdown body, icon, size and media. */
export function PointEditor({
  point,
  cdnBase,
  onChange,
  onFace,
  onMove,
  moving,
  onDuplicate,
  onDelete,
  onDone,
}: PointEditorProps) {
  const id = useId();
  const [iconQuery, setIconQuery] = useState('');
  // The parent keys this component by point id, so this starts fresh per point.
  const [title, setTitle] = useState(point.title);
  const icons = searchIcons(iconQuery);
  // An off-list stored icon renders as the fallback, so the picker shows that as selected.
  const current = pointIcon(point.icon);
  const unavailable = point.icon != null && current !== point.icon;
  const size = point.size ?? 1;

  return (
    <div className="ed-point" aria-label={`Edit point ${point.title}`} role="group">
      <div className="ed-field">
        <label className="ed-label" htmlFor={`${id}-title`}>
          Title
        </label>
        <input
          id={`${id}-title`}
          className="ed-input"
          value={title}
          maxLength={MAX_TITLE_LENGTH}
          onChange={(e) => {
            setTitle(e.target.value);
            // An empty title can't be saved (contract min 1): the doc keeps the last one.
            if (e.target.value.trim()) onChange({ title: e.target.value.trim() });
          }}
          onBlur={() => setTitle(point.title)}
        />
      </div>
      <BodyField point={point} onChange={onChange} />
      <div className="ed-field">
        <label className="ed-label" htmlFor={`${id}-icon`}>
          Icon
        </label>
        <input
          id={`${id}-icon`}
          className="ed-input"
          type="search"
          placeholder="Search icons"
          value={iconQuery}
          onChange={(e) => setIconQuery(e.target.value)}
        />
        <div className="ed-icons" role="radiogroup" aria-label="Point icon">
          {icons.map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={name === current}
              aria-label={name}
              title={name}
              className="ed-icons__opt"
              onClick={() => onChange({ icon: name === 'info' ? null : name })}
            >
              <i className={`fa-solid fa-${name}`} aria-hidden="true" />
            </button>
          ))}
          {icons.length === 0 && <p className="ed-note">No icon matches.</p>}
        </div>
        {unavailable && (
          <p className="ed-note">
            The stored icon “{point.icon}” isn’t available, so it shows as {FALLBACK_ICON}. Pick one
            to replace it.
          </p>
        )}
      </div>
      <div className="ed-field">
        <label className="ed-label" htmlFor={`${id}-size`}>
          Size <span className="ed-label__hint">{size.toFixed(1)}×</span>
        </label>
        <input
          id={`${id}-size`}
          type="range"
          min={POINT_SIZE_MIN}
          max={POINT_SIZE_MAX}
          step={POINT_SIZE_STEP}
          value={size}
          onFocus={onFace}
          onPointerDown={onFace}
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange({ size: v === 1 ? null : v });
          }}
        />
      </div>
      <MediaField key={point.id} point={point} cdnBase={cdnBase} onChange={onChange} />
      <div className="ed-point__tools">
        <Button
          variant="ghost"
          size="sm"
          icon={moving ? 'fa-solid fa-xmark' : 'fa-solid fa-crosshairs'}
          aria-pressed={moving}
          onClick={onMove}
        >
          {moving ? 'Cancel move' : 'Move'}
        </Button>
        <Button variant="ghost" size="sm" icon="fa-solid fa-clone" onClick={onDuplicate}>
          Duplicate
        </Button>
      </div>
      <div className="ed-point__actions">
        <Button variant="ghost" size="sm" icon="fa-solid fa-trash" onClick={onDelete}>
          Delete point
        </Button>
        <Button variant="primary" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
