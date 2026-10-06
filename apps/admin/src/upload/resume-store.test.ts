import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearBackgroundRecord,
  clearResumeRecord,
  parseResumeRecord,
  readBackgroundRecords,
  readResumeRecord,
  RESUME_MAX_AGE_MS,
  targetFromParams,
  writeBackgroundRecord,
  writeResumeRecord,
} from './resume-store.js';

const NOW = 1_000_000_000;
const raw = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    owner: 'u1',
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
    writeResumeRecord({
      owner: 'u1',
      fileName: 'a.jpg',
      target: { kind: 'new-tour' },
      landed: null,
    });
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

  it('keeps appended only as true, and only on a landed record', () => {
    expect(parseResumeRecord(raw({ appended: true }), NOW)?.appended).toBe(true);
    expect(parseResumeRecord(raw(), NOW)).not.toHaveProperty('appended');
    expect(parseResumeRecord(raw({ appended: 'yes' }), NOW)).not.toHaveProperty('appended');
    expect(parseResumeRecord(raw({ appended: true, landed: null }), NOW)).not.toHaveProperty(
      'appended',
    );
  });

  it('keeps the tour a replace target belongs to', () => {
    const target = { kind: 'replace', panoId: 'p9', tourId: 'tour-2' };
    expect(parseResumeRecord(raw({ target }), NOW)?.target).toEqual(target);
  });

  it.each([
    ['garbage', 'not json'],
    ['a wrong version', raw({ v: 2 })],
    ['no owner', raw({ owner: undefined })],
    ['an empty owner', raw({ owner: '' })],
    ['a bad target id', raw({ target: { kind: 'add', tourId: '../x' } })],
    ['an unknown target', raw({ target: { kind: 'other' } })],
    ['a replace with no tourId', raw({ target: { kind: 'replace', panoId: 'p9' } })],
    [
      'a replace with a bad tourId',
      raw({ target: { kind: 'replace', panoId: 'p9', tourId: '../x' } }),
    ],
    ['a bad landed panoId', raw({ landed: { panoId: 'a/b', mode: { kind: 'fresh' } } })],
    ['a bad mode', raw({ landed: { panoId: 'p', mode: { kind: 'replace' } } })],
    ['a stale record', raw({ savedAt: NOW - RESUME_MAX_AGE_MS - 1 })],
    ['a future record', raw({ savedAt: NOW + 1 })],
  ])('rejects %s', (_name, value) => {
    expect(parseResumeRecord(value, NOW)).toBeNull();
  });

  it('removes a stored record that no longer parses (a replace saved before tourId)', () => {
    sessionStorage.setItem(
      'panote.upload.resume',
      raw({ target: { kind: 'replace', panoId: 'p9' }, savedAt: Date.now() }),
    );
    expect(readResumeRecord()).toBeNull();
    expect(sessionStorage.getItem('panote.upload.resume')).toBeNull();
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() =>
      writeResumeRecord({ owner: 'u1', fileName: 'a', target: { kind: 'new-tour' }, landed: null }),
    ).not.toThrow();
    expect(readResumeRecord()).toBeNull();
  });
});

describe('background records', () => {
  const rec = (panoId: string, fileName = `${panoId}.jpg`) => ({
    owner: 'u1',
    fileName,
    target: { kind: 'add' as const, tourId: 'tour-1' },
    landed: { panoId, mode: { kind: 'fresh' as const } },
  });

  it('keeps one per landed pano, apart from the foreground record', () => {
    writeResumeRecord({
      owner: 'u1',
      fileName: 'fg.jpg',
      target: { kind: 'new-tour' },
      landed: null,
    });
    writeBackgroundRecord(rec('p1'));
    writeBackgroundRecord(rec('p2'));
    writeBackgroundRecord(rec('p1', 'again.jpg'));
    expect(readBackgroundRecords().map((r) => r.fileName)).toEqual(['p2.jpg', 'again.jpg']);

    clearResumeRecord();
    clearBackgroundRecord('p2');
    expect(readBackgroundRecords().map((r) => r.landed.panoId)).toEqual(['p1']);
    clearBackgroundRecord('p1');
    expect(sessionStorage.getItem('panote.upload.resume.bg')).toBeNull();
  });

  it('drops entries that no longer parse', () => {
    sessionStorage.setItem(
      'panote.upload.resume.bg',
      JSON.stringify([
        { v: 1, ...rec('p1'), savedAt: Date.now() },
        { v: 1, owner: 'u1' },
      ]),
    );
    expect(readBackgroundRecords()).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem('panote.upload.resume.bg')!)).toHaveLength(1);
  });
});

describe('targetFromParams', () => {
  const t = (q: string) => targetFromParams(new URLSearchParams(q));
  it('maps the editor links, ignoring bad ids', () => {
    expect(t('')).toEqual({ kind: 'new-tour' });
    expect(t('resume=upload')).toEqual({ kind: 'new-tour' });
    expect(t('tour=tour-1')).toEqual({ kind: 'add', tourId: 'tour-1' });
    expect(t('tour=tour-1&replace=p9')).toEqual({
      kind: 'replace',
      panoId: 'p9',
      tourId: 'tour-1',
    });
    expect(t('tour=../x&replace=p9')).toEqual({ kind: 'new-tour' });
    expect(t('tour=tour-1&replace=a/b')).toEqual({ kind: 'add', tourId: 'tour-1' });
  });
});
