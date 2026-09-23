import { describe, expect, it } from 'vitest';
import { deriveUploadTarget } from './upload-prefix.js';

describe('deriveUploadTarget', () => {
  it('returns the exact prefix and panoId for a valid key', () => {
    expect(deriveUploadTarget('panos/ae-_vTXvv70/p1/original')).toEqual({
      prefix: 'panos/ae-_vTXvv70/p1/',
      panoId: 'p1',
    });
  });

  // "abc123" is charset-valid but not something encodeId would actually
  // produce - pins that it still passes through unchanged either way.
  it('preserves an owner segment that is charset-valid but not encodeId-produced, unchanged', () => {
    expect(deriveUploadTarget('panos/abc123/p1/original')).toEqual({
      prefix: 'panos/abc123/p1/',
      panoId: 'p1',
    });
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
