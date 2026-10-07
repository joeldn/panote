import { Button, Modal, ModalHeader, useModalTitleId } from '@internal/ui';
import { tilesBaseUrl } from '@internal/web-kit';
import { useEffect, useState } from 'react';

import { useConfig } from '../config-context.js';
import { coverUrl } from '../dashboard/cover.js';
import { relativeTime } from '../dashboard/format.js';
import type { PanoSummary } from '../dashboard/types.js';
import { listAllPanos, type LoadStatus } from '../dashboard/use-dashboard.js';
import { panoTitle } from '../dashboard/use-unused-panos.js';
import { useSession } from '../session.js';
import { addPanoToTour, TOUR_FULL_MESSAGE } from '../upload/finalize.js';
import { addErrorMessage, libraryOf } from './library.js';
import { UNTITLED_PANO } from './model.js';

export interface LibraryPickerProps {
  tourId: string;
  /** The tour's scenes as saved (the picker only opens with nothing unsaved). */
  tourPanoIds: readonly string[];
  /** The tour is at MAX_TOUR_SCENES. */
  full: boolean;
  onClose(): void;
  /** The pano is in the server's tour: fold it into the editor and show it. */
  onAdded(panoId: string): Promise<void>;
}

function Thumb({ src }: { src: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (src && src !== failed) {
    return (
      <img
        className="ed-lib__thumb"
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(src)}
      />
    );
  }
  return (
    <span className="ed-lib__thumb ed-lib__thumb--empty" aria-hidden="true">
      <i className="fa-solid fa-panorama" />
    </span>
  );
}

/**
 * "Add pano → from library": the owner's ready panos, added as a new scene the same
 * way an upload is (config create-only, then an If-Match append to the tour). Mount
 * it only while open, so every open loads a fresh list.
 */
export function LibraryPicker({ tourId, tourPanoIds, full, onClose, onAdded }: LibraryPickerProps) {
  const { api } = useSession();
  const config = useConfig();
  const titleId = useModalTitleId();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [panos, setPanos] = useState<PanoSummary[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const tilesBase = tilesBaseUrl(config);

  useEffect(() => {
    let cancelled = false;
    listAllPanos(api).then(
      (list) => {
        if (cancelled) return;
        setPanos(list);
        setStatus('ready');
      },
      () => {
        if (!cancelled) setStatus('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, reloadKey]);

  const add = async (pano: PanoSummary) => {
    if (adding) return;
    setAdding(pano.panoId);
    setError(null);
    try {
      await addPanoToTour(api, tourId, pano.panoId, pano.title ?? UNTITLED_PANO);
      await onAdded(pano.panoId);
    } catch (e) {
      setError(addErrorMessage(e));
      setAdding(null);
    }
  };

  const library = libraryOf(panos, tourPanoIds);

  let body;
  if (status === 'loading') {
    body = (
      <p className="ed-lib__note" role="status">
        Loading your panos…
      </p>
    );
  } else if (status === 'error') {
    body = (
      <div className="ed-lib__alert" role="alert">
        <span>Couldn’t load your panos.</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setStatus('loading');
            setReloadKey((k) => k + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        {full && library.addable > 0 && (
          <p className="ed-lib__alert" role="note">
            {TOUR_FULL_MESSAGE}
          </p>
        )}
        {library.entries.length === 0 ? (
          <p className="ed-lib__note">
            None of your panos are ready to add yet. Upload one with <b>Add pano</b>.
          </p>
        ) : (
          library.addable === 0 && (
            <p className="ed-lib__note">Every pano in your library is already in this tour.</p>
          )
        )}
        {library.entries.length > 0 && (
          <ul className="ed-lib__list" aria-label="Your panos">
            {library.entries.map(({ pano, inTour }) => {
              const title = panoTitle(pano);
              return (
                <li key={pano.panoId} className="ed-lib__row">
                  <Thumb src={coverUrl(tilesBase, pano)} />
                  <span className="ed-lib__text">
                    <span className="ed-lib__title">{title}</span>
                    <span className="ed-lib__meta">
                      Updated {relativeTime(pano.updatedAt, now)}
                    </span>
                  </span>
                  {inTour ? (
                    <span className="ed-lib__in">
                      <i className="fa-solid fa-check" aria-hidden="true" /> In this tour
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="accent"
                      pill
                      busy={adding === pano.panoId}
                      disabled={full || (adding !== null && adding !== pano.panoId)}
                      aria-label={`Add “${title}” to this tour`}
                      onClick={() => void add(pano)}
                    >
                      Add
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {library.notReady > 0 && (
          <p className="ed-lib__note ed-lib__note--small">
            {library.notReady === 1
              ? '1 pano isn’t shown because it’s still processing or couldn’t be processed.'
              : `${library.notReady} panos aren’t shown because they’re still processing or couldn’t be processed.`}
          </p>
        )}
      </>
    );
  }

  // Closing mid-add would drop the result on the floor: wait for it.
  const close = adding ? () => {} : onClose;
  return (
    <Modal open onClose={close} width={560} labelledBy={titleId}>
      <ModalHeader
        id={titleId}
        title="Add from library"
        subtitle="A pano you add keeps its points, shared with any other tour using it."
        onClose={close}
      />
      <div className="ed-lib">
        {error && (
          <p className="ed-lib__alert" role="alert">
            {error}
          </p>
        )}
        {body}
      </div>
    </Modal>
  );
}
