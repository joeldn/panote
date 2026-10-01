import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearResumeRecord,
  parseResumeRecord,
  readResumeRecord,
  RESUME_MAX_AGE_MS,
  targetFromParams,
  writeResumeRecord,
} from './resume-store.js';

const NOW = 1_000_000_000;
const raw = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    fileName: 'a.jpg',
    target: { kind: 'add', tourId: 'tour-1' },
    landed: { panoId: 'pano-1', mode: { kind: 'replace', baselineVersion: 't1-a' } },
    savedAt: NOW,
    ...over,
  });

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('resume record', () => {
  it('round-trips through sessionStorage and clears', () => {
    writeResumeRecord({ fileName: 'a.jpg', target: { kind: 'new-tour' }, landed: null });
    expect(readResumeRecord()).toMatchObject({ fileName: 'a.jpg', target: { kind: 'new-tour' } });
    clearResumeRecord();
    expect(readResumeRecord()).toBeNull();
  });

  it('parses a valid record', () => {
    expect(parseResumeRecord(raw(), NOW)).toMatchObject({
      target: { kind: 'add', tourId: 'tour-1' },
      landed: { panoId: 'pano-1', mode: { kind: 'replace', baselineVersion: 't1-a' } },
    });
  });

  it.each([
    ['garbage', 'not json'],
    ['a wrong version', raw({ v: 2 })],
    ['a bad target id', raw({ target: { kind: 'add', tourId: '../x' } })],
    ['an unknown target', raw({ target: { kind: 'other' } })],
    ['a bad landed panoId', raw({ landed: { panoId: 'a/b', mode: { kind: 'fresh' } } })],
    ['a bad mode', raw({ landed: { panoId: 'p', mode: { kind: 'replace' } } })],
    ['a stale record', raw({ savedAt: NOW - RESUME_MAX_AGE_MS - 1 })],
    ['a future record', raw({ savedAt: NOW + 1 })],
  ])('rejects %s', (_name, value) => {
    expect(parseResumeRecord(value, NOW)).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() =>
      writeResumeRecord({ fileName: 'a', target: { kind: 'new-tour' }, landed: null }),
    ).not.toThrow();
    expect(readResumeRecord()).toBeNull();
  });
});

describe('targetFromParams', () => {
  const t = (q: string) => targetFromParams(new URLSearchParams(q));
  it('maps the editor links, ignoring bad ids', () => {
    expect(t('')).toEqual({ kind: 'new-tour' });
    expect(t('resume=upload')).toEqual({ kind: 'new-tour' });
    expect(t('tour=tour-1')).toEqual({ kind: 'add', tourId: 'tour-1' });
    expect(t('tour=tour-1&replace=p9')).toEqual({ kind: 'replace', panoId: 'p9' });
    expect(t('tour=../x&replace=p9')).toEqual({ kind: 'new-tour' });
    expect(t('tour=tour-1&replace=a/b')).toEqual({ kind: 'add', tourId: 'tour-1' });
  });
});
