import { describe, expect, it } from 'vitest';

import {
  ClientErrorReportSchema,
  MAX_ERROR_FRAMES,
  MAX_ERROR_MESSAGE_LENGTH,
  scrubErrorText,
} from './client-error.js';

describe('scrubErrorText', () => {
  it('drops a query string and fragment but keeps the line and column of a frame', () => {
    expect(scrubErrorText('at f (https://panote.dev/assets/index-Ab12.js?v=1#x:10:5)')).toBe(
      'at f (https://panote.dev/assets/index-Ab12.js:10:5)',
    );
    expect(scrubErrorText('f@https://panote.dev/assets/a.js?token=abc:3:7')).toBe(
      'f@https://panote.dev/assets/a.js:3:7',
    );
  });

  it('drops a query string or fragment in a message, wherever the URL ends', () => {
    expect(scrubErrorText('Failed to load https://cdn.panote.dev/x.json?sig=s3cret now')).toBe(
      'Failed to load https://cdn.panote.dev/x.json now',
    );
    expect(scrubErrorText("GET 'https://panote.dev/app/callback?code=c&state=s'")).toBe(
      "GET 'https://panote.dev/app/callback'",
    );
    expect(scrubErrorText('https://panote.dev/#access_token=t')).toBe('https://panote.dev/');
  });

  it('masks emails and tour slugs', () => {
    expect(scrubErrorText('no account for jane.doe+x@example.co.uk')).toBe(
      'no account for <email>',
    );
    expect(scrubErrorText('https://cdn.panote.dev/slugs/my-secret-tour.json')).toBe(
      'https://cdn.panote.dev/slugs/:slug',
    );
    expect(scrubErrorText('at /s/my-secret-tour/embed')).toBe('at /s/:slug/embed');
  });

  it('leaves text without URLs alone', () => {
    const text = "Cannot read properties of undefined (reading 'x')";
    expect(scrubErrorText(text)).toBe(text);
  });
});

describe('ClientErrorReportSchema', () => {
  const report = {
    app: 'website',
    release: 'BxR2v9Qe',
    kind: 'error',
    message: 'TypeError: boom',
    stack: ['at f (https://panote.dev/assets/index-BxR2v9Qe.js:1:2)'],
    path: '/s/:slug',
  };

  it('accepts a well-formed report', () => {
    expect(ClientErrorReportSchema.safeParse(report).success).toBe(true);
  });

  it.each([
    ['an unknown app', { app: 'demo' }],
    ['an unknown kind', { kind: 'warning' }],
    ['a release with a slash', { release: 'a/b' }],
    ['a long message', { message: 'x'.repeat(MAX_ERROR_MESSAGE_LENGTH + 1) }],
    ['too many frames', { stack: Array<string>(MAX_ERROR_FRAMES + 1).fill('at f') }],
    ['a path with a query string', { path: '/app?x=1' }],
    ['a path with a fragment', { path: '/app#x' }],
    ['a full URL as the path', { path: 'https://panote.dev/' }],
  ])('rejects %s', (_label, patch) => {
    expect(ClientErrorReportSchema.safeParse({ ...report, ...patch }).success).toBe(false);
  });
});
