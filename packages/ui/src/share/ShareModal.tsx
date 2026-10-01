import { useId, useState, type ReactNode } from 'react';

import { Button } from '../Button.js';
import { cx } from '../cx.js';
import { Modal, ModalHeader } from '../Modal.js';
import { Segmented } from '../Segmented.js';
import { useModalTitleId } from '../use-modal-title-id.js';
import { VISIBILITY_META, type Visibility } from '../visibility.js';
import {
  DEFAULT_EMBED_HEIGHT,
  displayUrl,
  EMBED_HEIGHTS,
  embedSnippet,
  embedSrc,
  shareUrl,
  socialTargets,
  type EmbedHeight,
  type EmbedScope,
  type ShareTab,
} from './links.js';
import { SlugField } from './SlugField.js';
import { useCopy, type CopyState } from './use-copy.js';

export interface SharePano {
  id: string;
  name: string;
}

export interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  /** `VITE_SITE_ORIGIN`, e.g. `https://panote.io`. */
  siteOrigin: string;
  /** Tour title, used as the social share text. */
  title: string;
  /** The live slug; null while the tour isn't published. */
  slug: string | null;
  visibility: Visibility;
  /** `visitor` is the Link-only sheet on /s/:slug: socials and copy, no tabs or slug edit. */
  variant?: 'owner' | 'visitor';
  tab?: ShareTab;
  onTabChange?: (tab: ShareTab) => void;
  /** The pano open in the editor, offered as "This pano only" on the Embed tab. */
  currentPano?: SharePano | null;
  /** Owner only. Saves a normalised, valid slug; a rejection's message shows inline. */
  onCommitSlug?: (slug: string) => Promise<void>;
  /** Owner only. A rejection's message shows under the options. */
  onVisibilityChange?: (visibility: Visibility) => Promise<void>;
  /** Owner only, unpublished tour: makes it live. A rejection's message shows inline. */
  onPublish?: () => Promise<void>;
  /** Unpublished tour that has to pick a slug first (publish said 409 slug lost/taken). */
  slugRequired?: boolean;
  loading?: boolean;
  /** Status line under the banner, e.g. a load error or where an old link now redirects. */
  notice?: ReactNode;
}

const VISIBILITY_OPTIONS: ReadonlyArray<{ value: Visibility; desc: string }> = [
  { value: 'public', desc: 'Anyone with the link; may appear in panote discovery.' },
  { value: 'unlisted', desc: 'Only people with the link. Hidden from discovery.' },
];

const TAB_OPTIONS = [
  { value: 'link' as const, label: 'Link' },
  { value: 'privacy' as const, label: 'Privacy' },
  { value: 'embed' as const, label: 'Embed' },
];

const EMBED_STEPS = [
  { title: 'Copy the code above', body: 'It is a plain iframe — nothing to install.' },
  {
    title: 'Paste it into an embed block',
    body: 'WordPress “Custom HTML”, Squarespace “Code”, Webflow “Embed”, Notion /embed, or straight into your page’s HTML.',
  },
  {
    title: 'Publish and check on a phone',
    body: 'The width follows your layout; adjust the height above if it feels cramped.',
  },
];

const errorMessage = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message ? e.message : fallback;

const copyLabel = (state: CopyState, idle: string): string =>
  state === 'copied' ? 'Copied ✓' : state === 'failed' ? 'Copy failed' : idle;

/** Share sheet: Link, Privacy (exactly two options) and Embed tabs (design README 8, 06–08). */
export function ShareModal(props: ShareModalProps) {
  const { open, onClose, variant = 'owner', tab: controlledTab, onTabChange } = props;
  const titleId = useModalTitleId();
  const idPrefix = `pn-share-${useId()}`;
  const [localTab, setLocalTab] = useState<ShareTab>('link');
  const owner = variant === 'owner';
  const tab = owner ? (controlledTab ?? localTab) : 'link';
  const setTab = (t: ShareTab) => {
    setLocalTab(t);
    onTabChange?.(t);
  };

  let body: ReactNode;
  if (props.loading) {
    body = (
      <p className="pn-share__status" role="status">
        Loading…
      </p>
    );
  } else if (props.slug === null) {
    body = <Unpublished {...props} />;
  } else {
    const panel = owner
      ? {
          role: 'tabpanel',
          id: `${idPrefix}-panel-${tab}`,
          'aria-labelledby': `${idPrefix}-tab-${tab}`,
        }
      : {};
    body = (
      <>
        {owner && <VisibilityBanner visibility={props.visibility} />}
        {props.notice && <div className="pn-share__notice">{props.notice}</div>}
        {owner && (
          <Segmented
            kind="tabs"
            idPrefix={idPrefix}
            aria-label="Share options"
            options={TAB_OPTIONS}
            value={tab}
            onChange={setTab}
            className="pn-share__tabs"
          />
        )}
        <div {...panel}>
          {tab === 'link' && <LinkTab {...props} slug={props.slug} owner={owner} />}
          {tab === 'privacy' && <PrivacyTab {...props} />}
          {tab === 'embed' && <EmbedTab {...props} slug={props.slug} />}
        </div>
      </>
    );
  }

  return (
    <Modal open={open} onClose={onClose} width={440} labelledBy={titleId}>
      <ModalHeader id={titleId} title="Share this tour" onClose={onClose} />
      <div className="pn-share">{body}</div>
    </Modal>
  );
}

function VisibilityBanner({ visibility }: { visibility: Visibility }) {
  const meta = VISIBILITY_META[visibility];
  return (
    <div className="pn-share__banner">
      <i className={meta.icon} style={{ color: meta.color }} aria-hidden="true" />
      <span>
        This tour is <b>{meta.label}</b>
      </span>
    </div>
  );
}

function LinkTab({
  siteOrigin,
  title,
  slug,
  owner,
  onCommitSlug,
}: ShareModalProps & { slug: string; owner: boolean }) {
  const url = shareUrl(siteOrigin, slug);
  const [copied, copy] = useCopy();
  return (
    <>
      <ul className="pn-share__socials">
        {socialTargets(url, title).map((s) => (
          <li key={s.id}>
            <a
              className="pn-share__social"
              href={s.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Share on ${s.label}`}
            >
              <span className="pn-share__social-icon">
                <i className={s.icon} aria-hidden="true" />
              </span>
              <span className="pn-share__social-label">{s.label}</span>
            </a>
          </li>
        ))}
      </ul>
      <div className="pn-share__label">Link</div>
      <div className="pn-share__url-row">
        <output className="pn-share__url" aria-label="Share link">
          {displayUrl(url)}
        </output>
        <Button variant="primary" className="pn-share__copy" onClick={() => void copy(url)}>
          {copyLabel(copied, 'Copy')}
        </Button>
      </div>
      {owner && onCommitSlug && (
        <SlugField
          slug={slug}
          prefix={displayUrl(shareUrl(siteOrigin, ''))}
          onCommit={onCommitSlug}
        />
      )}
    </>
  );
}

function PrivacyTab({ visibility, onVisibilityChange }: ShareModalProps) {
  const [pending, setPending] = useState<Visibility | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (next: Visibility) => {
    if (next === visibility || pending || !onVisibilityChange) return;
    setPending(next);
    setError(null);
    try {
      await onVisibilityChange(next);
    } catch (e) {
      setError(errorMessage(e, 'Could not change who can see this tour.'));
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <div role="radiogroup" aria-label="Who can see this tour" className="pn-share__options">
        {VISIBILITY_OPTIONS.map(({ value, desc }) => {
          const meta = VISIBILITY_META[value];
          const active = value === visibility;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-busy={pending === value || undefined}
              disabled={!onVisibilityChange || pending !== null}
              className={cx('pn-share__option', active && 'is-active')}
              onClick={() => void choose(value)}
            >
              <span className="pn-share__option-icon">
                <i className={meta.icon} aria-hidden="true" />
              </span>
              <span className="pn-share__option-text">
                <span className="pn-share__option-title">{meta.label}</span>
                <span className="pn-share__option-desc">{desc}</span>
              </span>
              {active && (
                <i className="fa-solid fa-circle-check pn-share__option-check" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
      {error && (
        <p className="pn-share__error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function EmbedTab({ siteOrigin, slug, currentPano }: ShareModalProps & { slug: string }) {
  const [scope, setScope] = useState<EmbedScope>('tour');
  const [height, setHeight] = useState<EmbedHeight>(DEFAULT_EMBED_HEIGHT);
  const [preview, setPreview] = useState(false);
  const [copied, copy] = useCopy();
  const pano = scope === 'pano' && currentPano ? currentPano : null;
  const src = embedSrc(siteOrigin, slug, pano?.id);
  const code = embedSnippet(src, height);

  const scopes: ReadonlyArray<{
    value: EmbedScope;
    label: string;
    desc: string;
    disabled: boolean;
  }> = [
    {
      value: 'tour',
      label: 'Whole tour',
      desc: 'Visitors can walk between every pano',
      disabled: false,
    },
    {
      value: 'pano',
      label: 'This pano only',
      desc: currentPano ? `${currentPano.name} — no links out` : 'Open a pano in the editor first',
      disabled: !currentPano,
    },
  ];

  return (
    <>
      <div className="pn-share__section">What to embed</div>
      <div role="radiogroup" aria-label="What to embed" className="pn-share__scopes">
        {scopes.map((s) => (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={scope === s.value}
            disabled={s.disabled}
            className={cx('pn-share__scope', scope === s.value && 'is-active')}
            onClick={() => setScope(s.value)}
          >
            <span className="pn-share__scope-title">{s.label}</span>
            <span className="pn-share__scope-desc">{s.desc}</span>
          </button>
        ))}
      </div>
      <div className="pn-share__section">Height</div>
      <div role="radiogroup" aria-label="Height" className="pn-share__heights">
        {EMBED_HEIGHTS.map((h) => (
          <button
            key={h.value}
            type="button"
            role="radio"
            aria-checked={height === h.value}
            className={cx('pn-share__height', height === h.value && 'is-active')}
            onClick={() => setHeight(h.value)}
          >
            {h.label}
          </button>
        ))}
      </div>
      <div className="pn-share__code-head">
        <div className="pn-share__section">Embed code</div>
        <button type="button" className="pn-share__link-btn" onClick={() => void copy(code)}>
          {copyLabel(copied, 'Copy code')}
        </button>
      </div>
      <pre className="pn-share__code" aria-label="Embed code">
        {code}
      </pre>
      <button
        type="button"
        className="pn-share__link-btn pn-share__preview-toggle"
        aria-expanded={preview}
        onClick={() => setPreview((p) => !p)}
      >
        <i className={preview ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'} aria-hidden="true" />
        {preview ? 'Hide preview' : 'Preview'}
      </button>
      {preview && (
        <iframe
          className="pn-share__preview"
          title="Embed preview"
          src={src}
          height={height}
          allow="fullscreen; xr-spatial-tracking"
          loading="lazy"
        />
      )}
      <hr className="pn-share__rule" />
      <div className="pn-share__section">How to add it</div>
      <ol className="pn-share__steps">
        {EMBED_STEPS.map((s, i) => (
          <li key={s.title}>
            <span className="pn-share__step-n" aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <span className="pn-share__step-title">{s.title}</span>
              <span className="pn-share__step-body">{s.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="pn-share__footnote">
        <i className="fa-solid fa-circle-info" aria-hidden="true" />
        <span>
          The embed is responsive and full-resolution, with no watermark. It picks up your tour
          settings — controls, map and compass — exactly as you set them.
        </span>
      </div>
    </>
  );
}

function Unpublished({
  siteOrigin,
  onPublish,
  onCommitSlug,
  slugRequired,
  notice,
}: ShareModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publish = async () => {
    if (!onPublish) return;
    setBusy(true);
    setError(null);
    try {
      await onPublish();
    } catch (e) {
      setError(errorMessage(e, 'Could not publish this tour.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="pn-share__banner">
        <i className="fa-solid fa-circle-info" aria-hidden="true" />
        <span>This tour isn’t live yet</span>
      </div>
      {notice && <div className="pn-share__notice">{notice}</div>}
      {slugRequired && onCommitSlug ? (
        <SlugField
          slug={null}
          prefix={displayUrl(shareUrl(siteOrigin, ''))}
          onCommit={onCommitSlug}
          startEditing
        />
      ) : (
        <>
          <p className="pn-share__hint">
            Publishing gives it a link. It starts Unlisted: only people with the link can see it.
          </p>
          {onPublish && (
            <Button variant="accent" busy={busy} onClick={() => void publish()}>
              Publish link
            </Button>
          )}
        </>
      )}
      {error && (
        <p className="pn-share__error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
