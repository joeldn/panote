import { describe, expect, it } from 'vitest';

import { EDITOR_DRAFT_PREFIX, sweepEditorDrafts } from './drafts.js';

const memory = (entries: Record<string, string>) => {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    map,
  };
};

describe('sweepEditorDrafts', () => {
  it('removes every editor draft and nothing else', () => {
    const store = memory({
      [`${EDITOR_DRAFT_PREFIX}u1:t1`]: '{}',
      [`${EDITOR_DRAFT_PREFIX}u2:t2`]: '{}',
      'panote.currentTour': 't1',
    });
    sweepEditorDrafts(store);
    expect([...store.map.keys()]).toEqual(['panote.currentTour']);
  });

  it('ignores storage that throws', () => {
    const broken = {
      get length(): number {
        throw new Error('blocked');
      },
      key: () => null,
      removeItem: () => {},
    };
    expect(() => sweepEditorDrafts(broken)).not.toThrow();
  });
});
