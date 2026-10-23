import { cleanup, configure, screen, within } from '@testing-library/react';
import { KNOWN_CONNECTIONS } from '@internal/web-kit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { renderSite } from './__fixtures__/auth.js';
import { routes } from './routes.js';

const renderAt = (path: string) => renderSite(path);

// Warm the lazy route modules once, so the first test doesn't time out on the transform.
// The first render of a lazy page can take over the default 1s on a loaded CI runner
// (seen under coverage); only the wait gets longer, the assertions are unchanged.
configure({ asyncUtilTimeout: 5000 });
beforeAll(async () => {
  await Promise.all([import('./Shell.js'), import('./pages.js')]);
});
afterEach(cleanup);

describe('website routes', () => {
  it('renders the shell and the landing page', async () => {
    renderAt('/');
    const banner = await screen.findByRole('banner');
    expect(within(banner).getByRole('img', { name: 'panote.io' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Free.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeTruthy();
  });

  it.each(['/privacy', '/terms', '/content-policy'])('renders %s', async (path) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('privacy describes self-serve account deletion', async () => {
    renderAt('/privacy');
    const choices = await screen.findByRole('heading', { name: 'Your choices' });
    const text = choices.nextElementSibling?.textContent ?? '';
    expect(text).toContain('choose Delete account');
    expect(text).toContain('sign-in record is removed within 30 days');
    expect(text).not.toContain('To delete your account, or to ask');
  });

  it('privacy says what a report or takedown keeps, even after account deletion', async () => {
    renderAt('/privacy');
    const holds = await screen.findByRole('heading', { name: 'Reports and legal holds' });
    const text = holds.nextElementSibling?.textContent ?? '';
    expect(text).toContain('as long as the law requires');
    expect(text).toContain('stays even if the account is deleted');
    expect(text).toContain('we keep your contact details');
    expect(screen.getByRole('article').textContent).toContain('Last updated 23 October 2026');
  });

  it('privacy says past viewers may keep loading an unpublished tour’s images', async () => {
    renderAt('/privacy');
    const upload = await screen.findByRole('heading', { name: 'What you upload' });
    const text = upload.nextElementSibling?.textContent ?? '';
    expect(text).toContain('already viewed it may still be able to load its panorama images');
    expect(text).toContain('once your account is a week old');
  });

  it('privacy is accurate about signed-in likes', async () => {
    renderAt('/privacy');
    await screen.findByRole('heading', { name: 'Visitors and analytics' });
    const page = screen.getByRole('article').textContent ?? '';
    expect(page).toContain('records your account id against that tour');
    expect(page).not.toContain('isn’t linked to an account');
  });

  it('content policy covers notices, counter-notices, repeat infringers and illegal images', async () => {
    renderAt('/content-policy');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Content and copyright' }),
    ).toBeTruthy();
    for (const name of [
      'What isn’t allowed',
      'Report a tour',
      'Copyright notices',
      'What we do',
      'Counter-notices',
      'Repeat infringers',
      'Illegal images',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    }
    const page = screen.getByRole('article').textContent ?? '';
    expect(page).toContain('under penalty of perjury');
    expect(page).toContain('your signature');
    expect(page).toContain('NCMEC');
    expect(page).toContain('We keep a private copy');
    expect(page).toContain('account is closed');
  });

  it('terms point to the content policy, and the footer links it', async () => {
    renderAt('/terms');
    await screen.findByRole('heading', { level: 1, name: 'Terms' });
    const article = screen.getByRole('article');
    expect(
      within(article)
        .getByRole('link', { name: 'content and copyright policy' })
        .getAttribute('href'),
    ).toBe('/content-policy');
    const legal = screen.getByRole('navigation', { name: 'Legal' });
    expect(within(legal).getByRole('link', { name: 'Content policy' }).getAttribute('href')).toBe(
      '/content-policy',
    );
  });

  it('privacy names every sign-in provider the app can offer', async () => {
    renderAt('/privacy');
    const account = await screen.findByRole('heading', { name: 'Your account' });
    const text = account.nextElementSibling?.textContent ?? '';
    for (const { label } of Object.values(KNOWN_CONNECTIONS)) expect(text).toContain(label);
    expect(text).toContain('a one-time code we email to it');
  });

  it('privacy joins only the trusted sign-ins that share a verified email', async () => {
    renderAt('/privacy');
    const account = await screen.findByRole('heading', { name: 'Your account' });
    const text = (account.nextElementSibling?.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain(
      'more than one of Google, Apple or an email code using the same email address',
    );
    expect(text).toContain('they are joined into one Panote account');
    expect(text).toContain('Signing in with Microsoft or Facebook keeps a separate account.');
  });

  it('privacy covers IP addresses, error reports, media embeds and backups', async () => {
    renderAt('/privacy');
    const textOf = async (name: string) => {
      const heading = await screen.findByRole('heading', { name });
      let text = '';
      for (let el = heading.nextElementSibling; el && el.tagName !== 'H2';) {
        text += ` ${el.textContent ?? ''}`;
        el = el.nextElementSibling;
      }
      return text.replace(/\s+/g, ' ');
    };
    const ips = await textOf('IP addresses and logs');
    expect(ips).toContain('We use it briefly to protect the service from abuse');
    expect(ips).toContain('We don’t store IP addresses with our analytics');
    expect(ips).toContain('kept for a limited time and then deleted automatically');
    const errors = await textOf('Error reports');
    expect(errors).toContain('no IP address, browser or country');
    const media = await textOf('Videos and media in tours');
    expect(media).toMatch(/YouTube.*Vimeo/);
    expect(media).toContain('youtube-nocookie.com');
    expect(media).toContain('sees your IP address and may set cookies');
    expect(await textOf('Backups')).toContain(
      'a tour or account you delete can remain in these private backups for up to 31 days',
    );
    expect(await textOf('How long we keep things')).toContain('Backups: up to 31 days.');
    const basis = await textOf('Why we’re allowed to');
    expect(basis).toContain('our contract with you');
    expect(basis).toContain('legitimate interest');
    expect(basis).toContain('Legal obligations');
  });

  it('privacy names no sign-in provider the app does not offer', async () => {
    renderAt('/privacy');
    await screen.findByRole('heading', { name: 'Your account' });
    expect(document.body.textContent).not.toMatch(/GitHub|LinkedIn/);
  });

  it('falls back to a 404 page', async () => {
    renderAt('/nope/deeper');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });

  it('loads the shell pages lazily and the tour routes eagerly', () => {
    const [tour, embed, shell] = routes;
    expect(tour?.element).toBeTruthy();
    expect(embed?.element).toBeTruthy();
    expect(tour?.lazy).toBeUndefined();
    expect(typeof shell?.lazy).toBe('function');
    expect(shell?.element).toBeUndefined();
    expect(shell?.children?.every((r) => typeof r.lazy === 'function' && !r.element)).toBe(true);
  });
});
