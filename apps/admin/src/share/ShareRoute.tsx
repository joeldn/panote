import { ShareModal, type SharePano, type ShareTab, type Visibility } from '@internal/ui';
import { isAuthError, publishErrorOf, type PublishError } from '@internal/web-kit';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { useAdminApi } from '../admin-api.js';
import { useConfig } from '../config-context.js';

interface Published {
  slug: string;
  visibility: Visibility;
}

interface Loaded {
  title: string;
  publish: Published | null;
  panos: SharePano[];
  startPanoId: string | undefined;
}

type LoadState =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; tour: Loaded };

const REASONS: Record<string, string> = {
  'not-ready': 'still processing',
  missing: 'missing',
  deleting: 'being deleted',
  'not-owned': 'not in your account',
};

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** User-facing copy for a publish-route failure (plan 3.2 error table). */
function publishMessage(err: PublishError, panos: SharePano[]): string {
  switch (err.kind) {
    case 'slug-taken':
      return 'That link is already taken. Try another.';
    case 'slug-lost':
      return 'This tour’s link now belongs to another tour. Pick a new one.';
    case 'slug-invalid':
      return err.reason === 'reserved'
        ? 'That link is reserved. Try another.'
        : 'Use 3–40 lowercase letters, numbers or dashes.';
    case 'conflict':
      return 'This tour’s sharing changed somewhere else just now. Try again.';
    case 'not-published':
      return 'This tour isn’t live any more. Close and reopen Share to publish it again.';
    case 'not-found':
      return 'This tour no longer exists.';
    case 'unprocessable': {
      if (err.scenes.length === 0) return 'Add a pano to this tour before publishing it.';
      const name = (id: string) => panos.find((p) => p.id === id)?.name ?? id;
      const list = err.scenes.map((s) => `${name(s.panoId)} (${REASONS[s.reason] ?? s.reason})`);
      return `Some panos can’t be published yet: ${list.join(', ')}.`;
    }
  }
}

const loadError = (e: unknown): string =>
  isAuthError(e) ? 'Sign in again to share this tour.' : 'Couldn’t load this tour. Try again.';

/** Share modal over the editor at /app/t/:tourId/share/:tab (screens 06–08). */
export function ShareRoute({ tab }: { tab: ShareTab }) {
  const { tourId = '' } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { siteOrigin } = useConfig();
  const api = useAdminApi();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [notice, setNotice] = useState<ReactNode>(null);
  const [slugRequired, setSlugRequired] = useState(false);

  useEffect(() => {
    let live = true;
    api.getTourWithConfigs(tourId).then(
      (res) => {
        if (!live) return;
        if (res.status !== 'ok') {
          setState({ status: 'error', message: 'This tour no longer exists.' });
          return;
        }
        const { tour, configs, publish } = res.data;
        const panos = tour.scenes.map((s, i) => {
          const entry = configs[s.panoId];
          const name = entry && 'config' in entry ? entry.config.title : `Pano ${i + 1}`;
          return { id: s.panoId, name };
        });
        setState({
          status: 'ready',
          tour: {
            title: tour.title,
            publish: publish ? { slug: publish.slug, visibility: publish.visibility } : null,
            panos,
            startPanoId: tour.startPanoId,
          },
        });
      },
      (e: unknown) => {
        if (live) setState({ status: 'error', message: loadError(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [api, tourId]);

  const query = search.toString();
  const go = (pathname: string, replace = false) =>
    void navigate({ pathname, search: query ? `?${query}` : '' }, { replace });

  const tour = state.status === 'ready' ? state.tour : null;
  const panos = tour?.panos ?? [];
  const setPublish = (publish: Published) =>
    setState((s) => (s.status === 'ready' ? { ...s, tour: { ...s.tour, publish } } : s));

  // Turns a publish-route failure into an Error whose message the modal shows inline.
  const asUserError = (e: unknown): Error => {
    if (isAuthError(e)) return new Error('Sign in again to change sharing.');
    const err = publishErrorOf(e);
    return new Error(err ? publishMessage(err, panos) : 'Something went wrong. Try again.');
  };

  const onCommitSlug = async (slug: string) => {
    if (!tour) return;
    try {
      if (tour.publish) {
        const res = await api.renameSlug(tourId, slug);
        setPublish({ ...tour.publish, slug: res.slug });
        const old = tour.publish.slug;
        setNotice(
          res.oldSlugRedirectsUntil && old !== res.slug
            ? `The old link /s/${old} redirects here until ${formatDate(res.oldSlugRedirectsUntil)}.`
            : null,
        );
      } else {
        const res = await api.publishTour(tourId, { slug });
        setPublish({ slug: res.slug, visibility: res.visibility });
        setSlugRequired(false);
        setNotice(null);
      }
    } catch (e) {
      throw asUserError(e);
    }
  };

  const onVisibilityChange = async (visibility: Visibility) => {
    if (!tour?.publish) return;
    try {
      const res = await api.setVisibility(tourId, visibility);
      setPublish({ ...tour.publish, visibility: res.visibility });
    } catch (e) {
      throw asUserError(e);
    }
  };

  const onPublish = async () => {
    try {
      const res = await api.publishTour(tourId);
      setPublish({ slug: res.slug, visibility: res.visibility });
    } catch (e) {
      const err = publishErrorOf(e);
      if (err?.kind === 'slug-lost' || err?.kind === 'slug-taken') {
        setSlugRequired(true);
        setNotice(publishMessage({ kind: 'slug-lost' }, panos));
        return;
      }
      throw asUserError(e);
    }
  };

  const requested = search.get('pano');
  const currentId =
    panos.find((p) => p.id === requested)?.id ??
    panos.find((p) => p.id === tour?.startPanoId)?.id ??
    panos[0]?.id;

  return (
    <ShareModal
      open
      onClose={() => go(`/t/${tourId}`)}
      tab={tab}
      onTabChange={(t) => go(`/t/${tourId}/share/${t}`, true)}
      siteOrigin={siteOrigin}
      title={tour?.title ?? ''}
      slug={tour?.publish?.slug ?? null}
      visibility={tour?.publish?.visibility ?? 'unlisted'}
      currentPano={panos.find((p) => p.id === currentId) ?? null}
      loading={state.status === 'loading'}
      error={state.status === 'error' ? state.message : undefined}
      notice={notice}
      slugRequired={slugRequired}
      onCommitSlug={onCommitSlug}
      onVisibilityChange={onVisibilityChange}
      onPublish={onPublish}
    />
  );
}
