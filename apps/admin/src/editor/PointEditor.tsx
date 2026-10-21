import { MAX_HOTSPOT_BODY_LENGTH, MAX_TITLE_LENGTH, type Hotspot } from '@internal/contracts';
import { Button, FALLBACK_ICON, MediaEmbed, pointIcon, Segmented } from '@internal/ui';
import { useId, useState } from 'react';

import { searchIcons } from './icons.js';
import type { HotspotPatch } from './model.js';
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
  onDelete: () => void;
  onDone: () => void;
}

function MediaField({ point, onChange }: Pick<PointEditorProps, 'point' | 'onChange'>) {
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
      <p className="ed-note">What are you adding? We only link to it — never host it.</p>
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

/** The selected point's panel: title, markdown body, icon, size and media. */
export function PointEditor({ point, onChange, onFace, onDelete, onDone }: PointEditorProps) {
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
      <MediaField key={point.id} point={point} onChange={onChange} />
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
