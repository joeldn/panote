import { MAX_HOTSPOT_BODY_LENGTH, MAX_TITLE_LENGTH, type Hotspot } from '@internal/contracts';
import { Button, Segmented } from '@internal/ui';
import { useId, useState } from 'react';

import { searchIcons } from './icons.js';
import type { HotspotPatch } from './model.js';
import { isCdnMedia, mediaInput, parseMedia, type MediaKind } from './media.js';

type MediaChoice = 'none' | MediaKind;

const MEDIA_OPTIONS: Array<{ value: MediaChoice; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
  { value: 'youtube', label: 'YouTube' },
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
  onDelete: () => void;
  onDone: () => void;
}

function MediaField({
  point,
  cdnBase,
  onChange,
}: Omit<PointEditorProps, 'onFace' | 'onDelete' | 'onDone'>) {
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
  onDelete,
  onDone,
}: PointEditorProps) {
  const id = useId();
  const [iconQuery, setIconQuery] = useState('');
  // The parent keys this component by point id, so this starts fresh per point.
  const [title, setTitle] = useState(point.title);
  const icons = searchIcons(iconQuery);
  const current = point.icon ?? 'info';
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
      <div className="ed-field">
        <label className="ed-label" htmlFor={`${id}-body`}>
          Text <span className="ed-label__hint">markdown</span>
        </label>
        <textarea
          id={`${id}-body`}
          className="ed-input ed-textarea"
          value={point.body ?? ''}
          maxLength={MAX_HOTSPOT_BODY_LENGTH}
          rows={4}
          onChange={(e) => onChange({ body: e.target.value ? e.target.value : null })}
        />
      </div>
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
      </div>
      <div className="ed-field">
        <label className="ed-label" htmlFor={`${id}-size`}>
          Size <span className="ed-label__hint">{size.toFixed(1)}×</span>
        </label>
        <input
          id={`${id}-size`}
          type="range"
          min={0.5}
          max={3}
          step={0.1}
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
