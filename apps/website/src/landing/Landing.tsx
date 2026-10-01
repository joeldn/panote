import './landing.css';

import type { PublishedTour } from '@internal/contracts';
import { LogoMark, PanoStage, cx } from '@internal/ui';
import { stashPendingUpload, tilesBaseUrl } from '@internal/web-kit';
import {
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';

import { ConfigContext } from '../config-context.js';
import { StageFactoryContext } from '../tour/stage-factory.js';
import { UploadLink } from '../UploadLink.js';
import {
  COMPARE_ROWS,
  FAQS,
  FEATURES,
  FREE_REASONS,
  PILLARS,
  STEPS,
  USE_CASES,
} from './content.js';
import { useShowcase } from './use-showcase.js';

/** `/`: the marketing page (design screen 01). */
export function Landing() {
  const config = useContext(ConfigContext);
  const showcase = useShowcase(config?.cdnBase, config?.showcaseSlug);
  const tilesBase = config ? tilesBaseUrl(config) : null;

  return (
    <div className="landing">
      <Hero showcase={showcase} tilesBase={tilesBase} />
      <div className="landing__body">
        <Pillars />
        <HowItWorks />
        <Features />
        <Comparison />
        <WhyFree />
        <Showcase showcase={showcase} />
        <Faq />
        <FinalCta />
      </div>
    </div>
  );
}

function Hero({
  showcase,
  tilesBase,
}: {
  showcase: PublishedTour | null;
  tilesBase: string | null;
}) {
  return (
    <section className="landing-hero">
      {showcase && tilesBase ? (
        <HeroStage tour={showcase} tilesBase={tilesBase} />
      ) : (
        <div className="landing-hero__backdrop" aria-hidden="true" />
      )}
      <div className="landing-hero__scrim" aria-hidden="true" />
      <div className="landing-hero__content landing-wrap">
        {showcase && (
          <div className="landing-hero__live">
            <span className="landing-dot" aria-hidden="true" />
            live · drag to look around
          </div>
        )}
        <h1 className="landing-hero__title">
          Your 360° tours. Full resolution. <em>Free.</em>
        </h1>
        <p className="landing-hero__lede">
          Upload a panorama, link your scenes, add hotspots, share a link. Unlimited tours, no
          watermark, no paywall.
        </p>
        <div className="landing-hero__actions">
          <DropTarget />
          {showcase && (
            <Link to={`/s/${showcase.slug}`} className="landing-hero__tour">
              See a live tour <span aria-hidden="true">→</span>
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

function HeroStage({ tour, tilesBase }: { tour: PublishedTour; tilesBase: string }) {
  const createViewer = useContext(StageFactoryContext);
  const wrapRef = useRef<HTMLDivElement>(null);
  const start = tour.scenes.find((s) => s.panoId === tour.startPanoId) ?? tour.scenes[0];

  // The page scrolls over the hero, so the wheel never reaches the viewer's zoom.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener('wheel', stop, { capture: true });
    return () => el.removeEventListener('wheel', stop, { capture: true });
  }, []);

  if (!start) return null;
  return (
    <div ref={wrapRef} className="landing-hero__stage">
      <PanoStage
        baseUrl={tilesBase}
        panoId={start.panoId}
        {...(start.config.initialView && { view: start.config.initialView })}
        {...(start.config.north !== undefined && { north: start.config.north })}
        autoRotate
        aria-label={`Live panorama: ${tour.title}`}
        {...(createViewer && { createViewer })}
      />
    </div>
  );
}

/** The hero CTA. A dropped file waits in IndexedDB through sign-in; the admin upload takes it. */
function DropTarget() {
  const [over, setOver] = useState(false);
  const onDragOver = (e: DragEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    setOver(true);
  };
  const onDrop = (e: DragEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    setOver(false);
    const link = e.currentTarget;
    const file = e.dataTransfer.files[0];
    // Navigate either way; without a stash the admin app just opens the picker.
    void (file ? stashPendingUpload(file) : Promise.resolve(false)).then(() => link.click());
  };

  return (
    <UploadLink
      className={cx('landing-drop', over && 'landing-drop--over')}
      onDragOver={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <span className="landing-drop__icon" aria-hidden="true">
        ↑
      </span>
      <span>
        <span className="landing-drop__title">Upload your first tour</span>{' '}
        <span className="landing-drop__sub">free — sign in with Google, live in seconds</span>
      </span>
    </UploadLink>
  );
}

function SectionHead({ title, aside }: { title: ReactNode; aside: string }) {
  return (
    <div className="landing-head">
      <h2 className="landing-h2">{title}</h2>
      <p className="landing-kicker">{aside}</p>
    </div>
  );
}

function Pillars() {
  return (
    <section className="landing-wrap landing-pillars">
      <SectionHead
        title="Hosted ease, without the free-tier catches."
        aside="Free hosts cap your resolution and stamp a watermark on your work. Panote doesn’t."
      />
      <div className="landing-pillars__grid">
        {PILLARS.map((p) => (
          <div key={p.tag} className="landing-pillar">
            <div className="landing-pillar__icon">
              <i className={p.icon} aria-hidden="true" />
            </div>
            <div className="landing-pillar__tag">{p.tag}</div>
            <h3 className="landing-pillar__title">{p.title}</h3>
            <p className="landing-pillar__body">{p.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" className="landing-wrap landing-how">
      <SectionHead
        title={
          <>
            From one photo to a place,
            <br />
            <em className="landing-muted">in four moves.</em>
          </>
        }
        aside="No rig, no stitching software, no plug-ins. Just the photo your 360 camera already made."
      />
      <ol className="landing-steps">
        {STEPS.map((s) => (
          <li key={s.num} className="landing-step">
            <div className="landing-step__num">{s.num}</div>
            <h3 className="landing-step__title">{s.title}</h3>
            <p className="landing-step__body">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className="landing-band">
      <div className="landing-wrap landing-features">
        <h2 className="landing-h2 landing-h2--wide">
          Everything a tour needs. <em className="landing-muted">Nothing it doesn’t.</em>
        </h2>
        <div className="landing-features__grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="landing-feature">
              <i className={f.icon} aria-hidden="true" />
              <h3 className="landing-feature__title">{f.title}</h3>
              <p className="landing-feature__body">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Comparison() {
  return (
    <section className="landing-wrap landing-wrap--narrow landing-compare">
      <div className="landing-compare__head">
        <div className="landing-eyebrow">Panote vs. the typical free tier</div>
        <h2 className="landing-h2 landing-h2--center">
          Same idea. <em className="landing-muted">None of the gates.</em>
        </h2>
      </div>
      <table className="landing-table">
        <thead>
          <tr>
            <th scope="col">Feature</th>
            <th scope="col">
              <span className="landing-table__brand">
                <LogoMark size={18} />
                Panote
              </span>
            </th>
            <th scope="col">Typical free host</th>
          </tr>
        </thead>
        <tbody>
          {COMPARE_ROWS.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td className="landing-table__us">
                <i className="fa-solid fa-check" aria-hidden="true" />
                {r.panote}
              </td>
              <td>{r.others}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function WhyFree() {
  return (
    <section id="free" className="landing-dark">
      <div className="landing-wrap landing-wrap--narrow landing-free">
        <div>
          <div className="landing-eyebrow landing-eyebrow--dark">The honest part</div>
          <h2 className="landing-h2">
            How is this
            <br />
            actually free?
          </h2>
        </div>
        <div>
          <p className="landing-free__lede">
            Free 360 hosts have shut down before, so it’s fair to be skeptical. Here’s the straight
            answer.
          </p>
          <ul className="landing-free__list">
            {FREE_REASONS.map((r) => (
              <li key={r.text}>
                <span className="landing-free__icon">
                  <i className={r.icon} aria-hidden="true" />
                </span>
                {r.text}
              </li>
            ))}
          </ul>
          <p className="landing-free__callout">
            Your tours stay live at full resolution, with no watermark and no upsell — for as long
            as you want them up.
          </p>
        </div>
      </div>
    </section>
  );
}

function Showcase({ showcase }: { showcase: PublishedTour | null }) {
  return (
    <section id="showcase" className="landing-wrap landing-showcase">
      <h2 className="landing-h2 landing-h2--wide">Built for anyone with a space to show.</h2>
      <ul className="landing-uses">
        {USE_CASES.map((u) => (
          <li key={u.title} className="landing-use" style={{ background: u.tint }}>
            <i className={u.icon} aria-hidden="true" />
            <span>{u.title}</span>
          </li>
        ))}
      </ul>
      {showcase && (
        <div className="landing-featured">
          <div className="landing-featured__badge">
            <span className="landing-dot" aria-hidden="true" />
            Featured tour
          </div>
          <div className="landing-featured__row">
            <div>
              <h3 className="landing-featured__title">{showcase.title}</h3>
              <p className="landing-featured__meta">
                {showcase.scenes.length === 1
                  ? '1 panorama'
                  : `${showcase.scenes.length} linked panoramas`}
                , full-resolution zoom.
              </p>
            </div>
            <Link to={`/s/${showcase.slug}`} className="landing-featured__cta">
              Walk through it <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}

function Faq() {
  const [open, setOpen] = useState(0);
  const baseId = useId();
  return (
    <section id="faq" className="landing-band">
      <div className="landing-wrap landing-faq">
        <h2 className="landing-h2 landing-h2--center">Questions, answered straight.</h2>
        <div className="landing-faq__list">
          {FAQS.map((f, i) => {
            const expanded = open === i;
            const panelId = `${baseId}-a${i}`;
            return (
              <div key={f.q} className={cx('landing-qa', expanded && 'landing-qa--open')}>
                <button
                  type="button"
                  className="landing-qa__q"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => setOpen(expanded ? -1 : i)}
                >
                  {f.q}
                  <span className="landing-qa__icon" aria-hidden="true">
                    <i className="fa-solid fa-plus" />
                  </span>
                </button>
                <div id={panelId} className="landing-qa__a" hidden={!expanded}>
                  {f.a}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="landing-wrap landing-final">
      <div className="landing-final__card">
        <h2 className="landing-h2">Your tour. Full resolution. Free.</h2>
        <p>
          Upload a panorama and get a link people can step inside. No watermark, no paywall — sign
          in with Google and you’re live.
        </p>
        <UploadLink className="landing-final__cta">
          Upload your first tour — free <span aria-hidden="true">→</span>
        </UploadLink>
      </div>
    </section>
  );
}
