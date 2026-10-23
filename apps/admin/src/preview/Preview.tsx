import {
  pickLanguage,
  tourLanguageList,
  translated,
  type TourPublishState,
  type TourWithConfigsOk,
} from '@internal/contracts';
import { Chip, LogoMark, ShareModal, TourViewer } from '@internal/ui';
import { tilesBaseUrl, toViewerTour } from '@internal/web-kit';
import { useContext, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';

import './preview.css';

import { useConfig } from '../config-context.js';
import type { EditorDocs } from '../editor/model.js';
import { previewData } from './preview-data.js';
import { StageFactoryContext } from './stage-factory.js';

/**
 * `/app/t/:tourId/preview` (screen 05, owner side): the tour as visitors will see it, drawn
 * in place of the editor, which stays mounted with its unsaved edits for the way back. No
 * views, likes or analytics are sent.
 */
export function EditorPreview({
  docs,
  publish,
  unsaved,
}: {
  docs: EditorDocs;
  publish: TourPublishState | null;
  unsaved: boolean;
}) {
  const data = useMemo(() => previewData(docs, publish), [docs, publish]);
  return <PreviewScreen tourId={docs.tourId} data={data} unsaved={unsaved} />;
}

function PreviewMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="app-shell__main">
      <section className="placeholder" role={children ? 'alert' : 'status'}>
        <h1>{title}</h1>
        {children}
      </section>
    </main>
  );
}

function PreviewScreen({
  tourId,
  data,
  unsaved,
}: {
  tourId: string;
  data: TourWithConfigsOk;
  unsaved: boolean;
}) {
  const config = useConfig();
  const createViewer = useContext(StageFactoryContext);
  const { tour: doc, configs, publish } = data;
  const [params, setParams] = useSearchParams();
  // As visitors get it: ?lang= (the editor's Preview passes the language being edited),
  // else the browser's languages, else the default.
  const lang = pickLanguage(doc.languages, params.get('lang'), navigator.languages ?? []);
  const { cdnBase } = config;
  const vt = useMemo(
    () => toViewerTour(doc, configs, lang, { cdnBase }),
    [doc, configs, lang, cdnBase],
  );
  const title = translated(doc.title, doc.i18n, lang, 'title');
  const description = translated(doc.description, doc.i18n, lang, 'description');
  const [sharing, setSharing] = useState(false);
  // The scene whose tiles failed to load, e.g. one still processing.
  const [notReady, setNotReady] = useState<string | null>(null);
  // Back to the pano and language the editor was on (the language picker here drops ?pano=).
  const [editor] = useState(() => {
    const back = new URLSearchParams();
    for (const key of ['pano', 'lang']) {
      const value = params.get(key);
      if (value) back.set(key, value);
    }
    const query = back.toString();
    return `/t/${encodeURIComponent(tourId)}${query ? `?${query}` : ''}`;
  });

  if (!vt.tour) {
    return (
      <PreviewMessage title="Nothing to preview yet">
        <p>
          Add a pano to this tour first. <Link to={editor}>Back to editor</Link>
        </p>
      </PreviewMessage>
    );
  }

  return (
    <TourViewer
      className="pv-tour"
      data={vt}
      title={title}
      description={description}
      lang={lang}
      languages={tourLanguageList(doc.languages)}
      onLanguageChange={(l) => setParams({ lang: l }, { replace: true })}
      baseUrl={tilesBaseUrl(config)}
      start={vt.tour.start}
      {...(createViewer && { createViewer })}
      bar={{
        home: (
          <Link to="/" className="pn-tourbar__home" aria-label="Your tours">
            <LogoMark size={30} />
          </Link>
        ),
        extras: () => (
          <Chip
            tone="light"
            mono
            icon="fa-solid fa-eye"
            className={unsaved ? 'pv-badge pv-badge--unsaved' : 'pv-badge'}
          >
            <span className="pv-badge__text">
              {unsaved ? 'Preview · not saved yet' : 'Preview'}
            </span>
          </Chip>
        ),
        end: (
          <Link className="pn-tourbar__btn pv-back" to={editor}>
            <i className="fa-solid fa-arrow-left" aria-hidden="true" />
            <span className="pv-back__label">Back to editor</span>
          </Link>
        ),
      }}
      // Visitors' share sheet, once there is a live link to share.
      {...(publish && { onShare: () => setSharing(true) })}
      onSceneChange={() => setNotReady(null)}
      onLoadError={(err, panoId) => {
        console.error('pano load failed', err);
        setNotReady(panoId);
      }}
    >
      <title>{`${title} · Preview · panote`}</title>
      {notReady && (
        <p className="pv-note" role="status">
          This pano’s tiles aren’t ready yet. They appear once processing finishes.
        </p>
      )}
      {publish && (
        <ShareModal
          open={sharing}
          onClose={() => setSharing(false)}
          variant="visitor"
          siteOrigin={config.siteOrigin}
          title={title}
          slug={publish.slug}
          visibility={publish.visibility}
        />
      )}
    </TourViewer>
  );
}
