import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderAdmin } from '../__fixtures__/auth.js';

// Only the account call matters here; it says whether the user is an operator.
const serverSaying = (operator: boolean | undefined) => {
  const fetch = async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'https://x');
    if (url.pathname === '/api/admin/account') {
      return Response.json({ email: null, signIns: ['google-oauth2'], operator });
    }
    if (url.pathname === '/api/admin/tours' || url.pathname === '/api/admin/shared-tours') {
      return Response.json({ tourIds: [], tours: [], cursor: null });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  return fetch;
};

afterEach(cleanup);

describe('/app/ops', () => {
  it('shows the operator area and its sections to an operator', async () => {
    renderAdmin('/app/ops', { fetch: serverSaying(true) });
    expect(await screen.findByRole('heading', { name: 'Operations' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Operations' });
    expect(nav.textContent).toContain('Overview');
  });

  it('is a plain "Page not found" for anyone else, and for an older API', async () => {
    renderAdmin('/app/ops', { fetch: serverSaying(false) });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    cleanup();
    renderAdmin('/app/ops', { fetch: serverSaying(undefined) });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });

  it('links to it from the account page for an operator only', async () => {
    renderAdmin('/app/account', { fetch: serverSaying(true) });
    expect(await screen.findByRole('link', { name: 'Operations' })).toBeTruthy();
    cleanup();
    renderAdmin('/app/account', { fetch: serverSaying(false) });
    expect(await screen.findByText('Google')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Operations' })).toBeNull();
  });
});
