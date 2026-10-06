import { describe, expect, it } from 'vitest';
import { deriveUploadTarget, errorText, panoIdForLog, redactOwner } from './upload-prefix.js';

describe('deriveUploadTarget', () => {
  it('returns the panoId for a valid key', () => {
    expect(deriveUploadTarget('panos/ae-_vTXvv70/p1/original')).toEqual({ panoId: 'p1' });
  });

  // "abc123" is charset-valid but not encodeId-produced; the owner segment
  // is validated but not returned.
  it('accepts an owner segment that is charset-valid but not encodeId-produced', () => {
    expect(deriveUploadTarget('panos/abc123/p1/original')).toEqual({ panoId: 'p1' });
  });

  it.each([
    ['too few segments', 'panos/owner/original'],
    ['too many segments', 'panos/owner/p1/extra/original'],
    ['missing the panos/ prefix', 'tours/owner/p1/original'],
    ['missing the /original suffix', 'panos/owner/p1/config.json'],
    ['no suffix at all', 'panos/owner/p1'],
  ])('throws on %s', (_label, key) => {
    expect(() => deriveUploadTarget(key)).toThrow();
  });

  it('throws on a panoId containing a space (invalid charset, correct segment count)', () => {
    expect(() => deriveUploadTarget('panos/owner/probe pano/original')).toThrow(/panoId/);
  });

  it('throws when the owner segment contains a "%"', () => {
    expect(() => deriveUploadTarget('panos/own%25er/p1/original')).toThrow(/owner/);
  });

  it('throws a clear, distinguishing error for a bad owner vs. a bad panoId', () => {
    expect(() => deriveUploadTarget('panos/a%b/p1/original')).toThrow(/owner segment/);
    expect(() => deriveUploadTarget('panos/owner/a%b/original')).toThrow(/panoId segment/);
  });

  // Each case fails only if a specific anchor (^ or $) is missing from
  // NOTIFICATION_KEY_RE.
  it.each([
    ['a leading prefix before "panos/"', 'x/panos/a/b/original'],
    ['a trailing path segment after "/original"', 'panos/a/b/original/x'],
    ['trailing characters appended directly to "original"', 'panos/a/b/originalx'],
  ])('throws on %s', (_label, key) => {
    expect(() => deriveUploadTarget(key)).toThrow();
  });

  // No segment count other than exactly two (owner, panoId) can match, since
  // each capture group is `[^/]+` and cannot span a "/".
  it.each([
    ['2 extra segments (4 total between panos/ and /original)', 'panos/a/b/c/d/original'],
    ['4 extra segments (6 total between panos/ and /original)', 'panos/a/b/c/d/e/f/original'],
  ])('throws on %s', (_label, key) => {
    expect(() => deriveUploadTarget(key)).toThrow();
  });

  it('throws on a config.json key instead of an original key', () => {
    expect(() => deriveUploadTarget('panos/a/b/config.json')).toThrow();
  });
});

describe('deriveUploadTarget error messages', () => {
  // These messages reach logs (consumer.ts) and the container's 500 body,
  // so they must not echo the owner segment.
  it.each([
    ['a bad shape', 'panos/secretowner/p1/extra/original'],
    ['a bad owner charset', 'panos/secret%owner/p1/original'],
  ])('does not echo the owner segment on %s', (_label, key) => {
    expect(() => deriveUploadTarget(key)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret') }),
    );
  });
});

describe('panoIdForLog', () => {
  it('returns the panoId segment of a well-formed key', () => {
    expect(panoIdForLog('panos/ae-_vTXvv70/p1/original')).toBe('p1');
  });

  it('returns the panoId segment even when its charset is invalid', () => {
    expect(panoIdForLog('panos/owner/bad panoid/original')).toBe('bad panoid');
  });

  it.each(['panos/owner/p1/extra/original', 'panos/owner/original', 'tours/owner/p1/original', ''])(
    'returns a placeholder, never the key, for %j',
    (key) => {
      expect(panoIdForLog(key)).toBe('<unparsed-key>');
    },
  );
});

describe('redactOwner', () => {
  it('replaces the owner segment of every panos/ key in the text', () => {
    expect(
      redactOwner('R2 DELETE panos/ae-_vTXvv70/p1/tile-failed -> 403; also panos/x/p2/original'),
    ).toBe('R2 DELETE panos/<owner>/p1/tile-failed -> 403; also panos/<owner>/p2/original');
  });

  it('redacts an owner with spaces, @ or %, up to the next slash', () => {
    expect(redactOwner('HEAD panos/a b/p1/original failed')).toBe(
      'HEAD panos/<owner>/p1/original failed',
    );
    expect(redactOwner('panos/joel@example.com/p1/original')).toBe('panos/<owner>/p1/original');
    expect(redactOwner('panos/secret%owner/p1/original')).toBe('panos/<owner>/p1/original');
  });

  it('stops at one segment: it redacts up to the first slash, not the last', () => {
    expect(redactOwner('panos/a b/p1/original and tiles/p1/x')).toBe(
      'panos/<owner>/p1/original and tiles/p1/x',
    );
  });

  it('never runs across a line break looking for a slash', () => {
    expect(redactOwner('panos/no slash here\nnext line /x')).toBe(
      'panos/no slash here\nnext line /x',
    );
  });

  it('leaves owner-free tile keys alone', () => {
    expect(redactOwner('R2 PUT tiles/p1/t1-abc/0/px/0-0.webp -> 500')).toBe(
      'R2 PUT tiles/p1/t1-abc/0/px/0-0.webp -> 500',
    );
  });
});

describe('errorText', () => {
  it('returns an Error message with the owner scrubbed', () => {
    expect(errorText(new Error('R2 DELETE panos/secret/p1/tile-failed -> 403'))).toBe(
      'R2 DELETE panos/<owner>/p1/tile-failed -> 403',
    );
  });

  it('stringifies a non-Error and scrubs it too', () => {
    expect(errorText('boom at panos/secret/p1/original')).toBe('boom at panos/<owner>/p1/original');
  });
});
