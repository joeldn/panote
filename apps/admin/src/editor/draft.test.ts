import type { TourWithConfigsOk } from '@internal/contracts';
import { sweepEditorDrafts } from '@internal/web-kit';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyDraft,
  DRAFT_MAX_AGE_MS,
  draftKey,
  readDraft,
  writeDraft,
  type DraftStorage,
} from './draft.js';
import { dirtyKeys, editorReducer, fromServer, type EditorDocs } from './model.js';

const ME = 'google-oauth2|me';
const OTHER = 'google-oauth2|other';

const server = (tourEtag = 'te', aEtag = 'ea'): TourWithConfigsOk => ({
  tour: { tourId: 't1', title: 'Old town', scenes: [{ panoId: 'a' }, { panoId: 'b' }] },
  etag: tourEtag,
  configs: {
    a: { config: { panoId: 'a', title: 'Square', hotspots: [] }, etag: aEtag },
    b: { config: { panoId: 'b', title: 'Church', hotspots: [] }, etag: 'eb' },
  },
});

const edited = (): EditorDocs =>
  [
    { type: 'tour/title', title: 'Draft title' } as const,
    { type: 'scene/title', panoId: 'a', title: 'Draft square' } as const,
  ].reduce<EditorDocs | null>(editorReducer, fromServer(server()))!;

beforeEach(() => localStorage.clear());

describe('editor drafts', () => {
  it('stores only dirty docs with their ETags, and nothing when clean', () => {
    expect(writeDraft(localStorage, ME, fromServer(server()))).toBe('clean');
    expect(localStorage.getItem(draftKey(ME, 't1'))).toBeNull();
    expect(writeDraft(localStorage, ME, edited())).toBe('stored');
    const draft = readDraft(localStorage, ME, 't1');
    expect(draft?.tour).toMatchObject({ etag: 'te', doc: { title: 'Draft title' } });
    expect(Object.keys(draft?.configs ?? {})).toEqual(['a']);
    expect(draft?.configs.a?.etag).toBe('ea');
  });

  it('is keyed by user: another user never reads it', () => {
    writeDraft(localStorage, ME, edited());
    expect(draftKey(ME, 't1')).toBe('panote:editor-draft:google-oauth2|me:t1');
    expect(readDraft(localStorage, OTHER, 't1')).toBeNull();
    expect(readDraft(localStorage, ME, 't1')).not.toBeNull();
  });

  it('reports a storage failure (quota) instead of pretending it stored', () => {
    const full: DraftStorage = {
      getItem: () => null,
      removeItem: () => {},
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    };
    expect(writeDraft(full, ME, edited())).toBe('failed');
  });

  it('sweeps every parked draft and nothing else', () => {
    writeDraft(localStorage, ME, edited());
    writeDraft(localStorage, OTHER, edited());
    localStorage.setItem('panote.currentTour', 't1');
    sweepEditorDrafts(localStorage);
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('panote.currentTour')).toBe('t1');
  });

  it('restores onto an unchanged server copy', () => {
    writeDraft(localStorage, ME, edited());
    const res = applyDraft(fromServer(server()), readDraft(localStorage, ME, 't1')!);
    expect(res.restored.sort()).toEqual(['pano:a', 'tour']);
    expect(res.discarded).toEqual([]);
    expect(dirtyKeys(res.docs).sort()).toEqual(['pano:a', 'tour']);
  });

  it('keeps the edits to a doc whose server ETag changed meanwhile, as a conflict on the old ETag', () => {
    writeDraft(localStorage, ME, edited());
    const res = applyDraft(
      fromServer(server('te-other', 'ea')),
      readDraft(localStorage, ME, 't1')!,
    );
    expect(res.restored).toEqual(['pano:a']);
    expect(res.conflicts).toEqual(['tour']);
    expect(res.discarded).toEqual([]);
    // Save would send the draft's ETag and get a 412, never overwrite the newer copy.
    expect(res.docs.tour).toMatchObject({
      etag: 'te',
      base: { title: 'Old town' },
      current: { title: 'Draft title' },
    });
  });

  it('drops the edits to a pano that is no longer in the tour', () => {
    writeDraft(localStorage, ME, edited());
    const gone = server();
    gone.tour.scenes = [{ panoId: 'b' }];
    delete gone.configs.a;
    const res = applyDraft(fromServer(gone), readDraft(localStorage, ME, 't1')!);
    expect(res.discarded).toEqual(['pano:a']);
    expect(res.docs.scenes.a).toBeUndefined();
  });

  it('restores nothing for a doc already saved elsewhere with the same edits', () => {
    writeDraft(localStorage, ME, edited());
    const same = server('te-other');
    same.tour.title = 'Draft title';
    const res = applyDraft(fromServer(same), readDraft(localStorage, ME, 't1')!);
    expect(res.conflicts).toEqual([]);
    expect(res.restored).toEqual(['pano:a']);
    expect(res.docs.tour.etag).toBe('te-other');
  });

  it('drops a draft older than the age limit', () => {
    const then = new Date('2026-10-01T00:00:00Z');
    writeDraft(localStorage, ME, edited(), then);
    const justInTime = new Date(then.getTime() + DRAFT_MAX_AGE_MS);
    expect(readDraft(localStorage, ME, 't1', justInTime)).not.toBeNull();
    const tooLate = new Date(then.getTime() + DRAFT_MAX_AGE_MS + 1);
    expect(readDraft(localStorage, ME, 't1', tooLate)).toBeNull();
    expect(localStorage.getItem(draftKey(ME, 't1'))).toBeNull();
  });

  it('discards an unreadable draft', () => {
    localStorage.setItem(
      draftKey(ME, 't1'),
      '{"v":1,"savedAt":"x","configs":{"a":{"etag":"e","config":{}}}}',
    );
    expect(readDraft(localStorage, ME, 't1')).toBeNull();
    expect(localStorage.getItem(draftKey(ME, 't1'))).toBeNull();
  });
});
