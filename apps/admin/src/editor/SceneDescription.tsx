import { MAX_SCENE_DESCRIPTION_LENGTH } from '@internal/contracts';
import { useId, useState } from 'react';

export interface SceneDescriptionProps {
  /** The stored description in the language being edited, '' when there is none. */
  value: string;
  /**
   * Being translated: `value` is the translation, and the default-language text shows
   * as the placeholder.
   */
  translating?: { name: string; placeholder: string } | null;
  disabled?: boolean;
  /** Every edit, untrimmed; the editor stores it trimmed. */
  onChange: (text: string) => void;
}

/** The pano's description, shown to visitors under About in the viewer. Plain text. */
export function SceneDescription({
  value,
  translating = null,
  disabled = false,
  onChange,
}: SceneDescriptionProps) {
  const id = useId();
  // What's being typed, so a trailing space or line break survives until blur.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? value;
  return (
    <div className="ed-field ed-pano-settings__description">
      <label className="ed-label" htmlFor={id}>
        Description {translating && <span className="ed-label__hint">{translating.name}</span>}
      </label>
      <textarea
        id={id}
        className="pn-input"
        value={text}
        // What it's for, in the empty field only (the default text while translating).
        placeholder={
          translating ? translating.placeholder : 'Visitors see it under About in the viewer.'
        }
        maxLength={MAX_SCENE_DESCRIPTION_LENGTH}
        rows={2}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(e.target.value);
        }}
        onBlur={() => setDraft(null)}
      />
    </div>
  );
}
