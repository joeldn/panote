import { MAX_HOTSPOT_BODY_LENGTH, MAX_TITLE_LENGTH, type Hotspot } from '@internal/contracts';
import { Button, FALLBACK_ICON, MediaEmbed, pointIcon, Segmented } from '@internal/ui';
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { searchIcons } from './icons.js';
import { useMenu } from './use-menu.js';
import { applyFormat, formatForKey, IS_MAC, type MarkdownFormat } from './markdown-format.js';
import {
  POINT_SIZE_MAX,
  POINT_SIZE_MIN,
  POINT_SIZE_STEP,
  type HotspotPatch,
  type TranslationPatch,
} from './model.js';
import { choiceOf, mediaInput, parseMedia, type MediaChoice } from './media.js';

type MediaPick = 'none' | MediaChoice;

const MEDIA_OPTIONS: Array<{ value: MediaPick; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'image', label: 'Image' },
  { value: 'audio', label: 'Audio' },
  { value: 'video', label: 'Video' },
  { value: 'embed', label: 'YouTube / Vimeo' },
  { value: 'link', label: 'Link' },
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

const MEDIA_PLACEHOLDER: Record<MediaChoice, string> = {
  image: 'Paste image URL (jpg, png, gif, webp)',
  audio: 'Paste audio file URL (mp3, wav, ogg)',
  video: 'Paste video file URL (mp4, webm)',
  embed: 'Paste a YouTube or Vimeo URL',
  link: 'Link URL',
};

const MEDIA_LABEL: Record<MediaChoice, string> = {
  image: 'Media link',
  audio: 'Media link',
  video: 'Media link',
  embed: 'YouTube or Vimeo link',
  link: 'Link URL',
};

export interface PointEditorProps {
  point: Hotspot;
  onChange: (patch: HotspotPatch) => void;
  /** Turn the view to face the point (while sizing it). */
  onFace: () => void;
  /** Start (or, while `moving`, cancel) moving the point to a new spot on the pano. */
  onMove: () => void;
  moving: boolean;
  onDuplicate: () => void;
  onDelete: () => void;
  onDone: () => void;
  /**
   * Editing a translation: title and text are this language's, with the default-language
   * text as the placeholder. Everything else is shared by every language.
   */
  translation?: { lang: string; name: string } | null;
  onTranslate?: (patch: TranslationPatch) => void;
}

type FieldProps = Pick<PointEditorProps, 'point' | 'onChange'>;

interface BodyFieldProps {
  value: string;
  /** `null` clears the text. */
  onValue: (body: string | null) => void;
  placeholder?: string | undefined;
}

/** The markdown body, with a toolbar (and its shortcuts) for the syntax the viewer renders. */
function BodyField({ value: body, onValue, placeholder }: BodyFieldProps) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  // Where the selection goes once the formatted text has rendered.
  const selectAfter = useRef<[number, number] | null>(null);

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
    onValue(next.value ? next.value : null);
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
        {...(placeholder && { placeholder })}
        maxLength={MAX_HOTSPOT_BODY_LENGTH}
        rows={4}
        onKeyDown={onKeyDown}
        onChange={(e) => onValue(e.target.value ? e.target.value : null)}
      />
    </div>
  );
}

function MediaField({ point, onChange }: FieldProps) {
  const id = useId();
  const stored = point.media;
  const [kind, setKind] = useState<MediaPick>(stored ? choiceOf(stored) : 'none');
  const [text, setText] = useState(stored ? mediaInput(stored) : '');
  const [error, setError] = useState<string | null>(null);

  // `detect` is off when the kind was just picked: an explicit choice isn't second-guessed.
  const commit = (k: MediaPick, value: string, detect = true) => {
    if (k === 'none' || !value.trim()) {
      setError(null);
      onChange({ media: null });
      return;
    }
    const parsed = parseMedia(k, value, detect);
    if (parsed.ok) {
      setError(null);
      // A YouTube/Vimeo page pasted under another kind is stored as the embed.
      setKind(choiceOf(parsed.media));
      onChange({ media: parsed.media });
    } else {
      setError(parsed.message);
    }
  };

  return (
    <fieldset className="ed-field ed-media">
      <legend className="ed-label">Media</legend>
      {/* Until there is something to show: then the preview says it. */}
      {!stored && (
        <p className="ed-note">What are you adding? We only link to it — never host it.</p>
      )}
      <Segmented
        aria-label="Media type"
        options={MEDIA_OPTIONS}
        value={kind}
        onChange={(k) => {
          setKind(k);
          commit(k, text, false);
        }}
      />
      {kind !== 'none' && (
        <>
          <label className="ed-sr" htmlFor={`${id}-url`}>
            {MEDIA_LABEL[kind]}
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
            aria-describedby={error ? `${id}-note` : undefined}
          />
        </>
      )}
      {error ? (
        <p id={`${id}-note`} className="ed-note ed-note--error" role="alert">
          {error}
        </p>
      ) : (
        stored &&
        kind !== 'none' && (
          // As visitors see it; keyed by the media so a fixed link retries a failed load.
          <div className="ed-media__preview">
            <MediaEmbed key={JSON.stringify(stored)} media={stored} title={point.title} />
          </div>
        )
      )}
    </fieldset>
  );
}

/** The point's occasional actions, Duplicate and Delete, behind a ⋯ button. */
function PointMenu({ onDuplicate, onDelete }: Pick<PointEditorProps, 'onDuplicate' | 'onDelete'>) {
  const { open, close, rootProps, buttonProps, menuProps } = useMenu();
  return (
    <div {...rootProps} className="ed-more ed-point__more">
      <button {...buttonProps} type="button" className="ed-icon-btn" aria-label="Point actions">
        <i className="fa-solid fa-ellipsis" aria-hidden="true" />
      </button>
      {open && (
        <div {...menuProps} className="ed-more__menu ed-more__menu--up" aria-label="Point actions">
          <button
            type="button"
            role="menuitem"
            className="ed-more__item"
            onClick={() => {
              close(false);
              onDuplicate();
            }}
          >
            <i className="fa-solid fa-clone" aria-hidden="true" />
            Duplicate
          </button>
          <button
            type="button"
            role="menuitem"
            className="ed-more__item ed-more__item--danger"
            onClick={() => {
              close(false);
              onDelete();
            }}
          >
            <i className="fa-solid fa-trash" aria-hidden="true" />
            Delete point
          </button>
        </div>
      )}
    </div>
  );
}

/** The selected point's panel: title, markdown body, icon, size and media. */
export function PointEditor({
  point,
  onChange,
  onFace,
  onMove,
  moving,
  onDuplicate,
  onDelete,
  onDone,
  translation = null,
  onTranslate,
}: PointEditorProps) {
  const id = useId();
  const [iconQuery, setIconQuery] = useState('');
  const lang = translation?.lang ?? null;
  const storedTitle = lang ? (point.i18n?.[lang]?.title ?? '') : point.title;
  // The parent keys this component by point id and language, so this starts fresh per both.
  const [title, setTitle] = useState(storedTitle);
  const icons = searchIcons(iconQuery);
  // An off-list stored icon renders as the fallback, so the picker shows that as selected.
  const current = pointIcon(point.icon);
  const unavailable = point.icon != null && current !== point.icon;
  const size = point.size ?? 1;

  return (
    <div className="ed-point" aria-label={`Edit point ${point.title}`} role="group">
      <div className="ed-field">
        <label className="ed-label" htmlFor={`${id}-title`}>
          Title {translation && <span className="ed-label__hint">{translation.name}</span>}
        </label>
        <input
          id={`${id}-title`}
          className="ed-input"
          value={title}
          {...(translation && { placeholder: point.title, lang: translation.lang })}
          maxLength={MAX_TITLE_LENGTH}
          onChange={(e) => {
            setTitle(e.target.value);
            const next = e.target.value.trim();
            // A blank translation falls back to the default title.
            if (lang) onTranslate?.({ title: next || null });
            // An empty title can't be saved (contract min 1): the doc keeps the last one.
            else if (next) onChange({ title: next });
          }}
          onBlur={() => setTitle(storedTitle)}
        />
      </div>
      {lang ? (
        <BodyField
          key={lang}
          value={point.i18n?.[lang]?.body ?? ''}
          placeholder={point.body}
          onValue={(body) => onTranslate?.({ body })}
        />
      ) : (
        <BodyField value={point.body ?? ''} onValue={(body) => onChange({ body })} />
      )}
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
      <MediaField key={point.id} point={point} onChange={onChange} />
      <div className="ed-point__actions">
        <Button
          variant="ghost"
          size="sm"
          icon={moving ? 'fa-solid fa-xmark' : 'fa-solid fa-crosshairs'}
          aria-pressed={moving}
          onClick={onMove}
        >
          {moving ? 'Cancel move' : 'Move'}
        </Button>
        <PointMenu onDuplicate={onDuplicate} onDelete={onDelete} />
        <Button variant="primary" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
