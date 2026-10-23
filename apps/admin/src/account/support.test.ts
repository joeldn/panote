import { describe, expect, it } from 'vitest';

import { supportHref } from './support.js';

const parts = (href: string) => {
  const [to, query] = href.split('?') as [string, string];
  const params = new URLSearchParams(query);
  return { to, subject: params.get('subject'), body: params.get('body') };
};

describe('supportHref', () => {
  it('fills in the account ID, encoded', () => {
    const href = supportHref('google-oauth2|1&x=2');
    expect(href).not.toContain('|');
    expect(parts(href)).toEqual({
      to: 'mailto:hello@panote.io',
      subject: 'Help with my Panote account',
      body: 'Account ID: google-oauth2|1&x=2\r\n\r\nWhat happened:\r\n',
    });
  });

  it('leaves the ID out when there is none', () => {
    expect(parts(supportHref(undefined)).body).toBe('What happened:\r\n');
  });
});
