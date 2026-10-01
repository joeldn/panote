import type { TourWithConfigsOk } from '@internal/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyDraft,
  draftKey,
  readDraft,
  sweepDrafts,
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
    sweepDrafts(localStorage);
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

  it('drops the edits to any doc whose server ETag changed meanwhile', () => {
    writeDraft(localStorage, ME, edited());
    const res = applyDraft(
      fromServer(server('te-other', 'ea')),
      readDraft(localStorage, ME, 't1')!,
    );
    expect(res.restored).toEqual(['pano:a']);
    expect(res.discarded).toEqual(['tour']);
    expect(res.docs.tour.current.title).toBe('Old town');
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
