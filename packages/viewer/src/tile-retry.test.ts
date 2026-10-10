import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEFAULT_MAX_ATTEMPTS,
  TileHttpError,
  TileRetryBudget,
  classifyFailure,
  classifyStatus,
  isAbortError,
} from './tile-retry.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Everything here runs on an injected clock, never on wall time or timers, so
// the whole policy is exercised deterministically under plain Node (this
// package has no jsdom and no fake-timer dependency — see vitest.config.ts).
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('classifyStatus', () => {
  it('treats 404 and 410 as permanent — the tile does not exist and never will', () => {
    expect(classifyStatus(404)).toBe('permanent');
    expect(classifyStatus(410)).toBe('permanent');
  });

  it('treats 401 and 403 as permanent — nothing refreshes a credential between attempts', () => {
    expect(classifyStatus(401)).toBe('permanent');
    expect(classifyStatus(403)).toBe('permanent');
  });

  it('treats 408, 425 and 429 as transient', () => {
    expect(classifyStatus(408)).toBe('transient');
    expect(classifyStatus(425)).toBe('transient');
    expect(classifyStatus(429)).toBe('transient');
  });

  it('treats every 5xx as transient', () => {
    expect(classifyStatus(500)).toBe('transient');
    expect(classifyStatus(503)).toBe('transient');
    expect(classifyStatus(599)).toBe('transient');
  });

  it('treats other 4xx as permanent', () => {
    expect(classifyStatus(400)).toBe('permanent');
    expect(classifyStatus(451)).toBe('permanent');
  });
});

describe('classifyFailure', () => {
  it('classifies a TileHttpError by its status', () => {
    expect(classifyFailure(new TileHttpError(404))).toBe('permanent');
    expect(classifyFailure(new TileHttpError(503))).toBe('transient');
  });

  it('keeps the thrown message shape used before the split', () => {
    expect(new TileHttpError(500).message).toBe('tile 500');
  });

  it('classifies a fetch rejection (no response at all) as transient', () => {
    expect(classifyFailure(new TypeError('Failed to fetch'))).toBe('transient');
  });

  it('classifies a decode failure as transient', () => {
    expect(classifyFailure(new Error('The source image could not be decoded'))).toBe('transient');
  });
});

describe('isAbortError', () => {
  it('recognises a DOMException AbortError', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('recognises a plain Error named AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('is false for other failures', () => {
    expect(isAbortError(new TileHttpError(500))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});

describe('TileRetryBudget', () => {
  it('measures cooldowns on the monotonic clock by default', () => {
    let t = 5_000;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    const budget = new TileRetryBudget(undefined, { baseDelayMs: 1_000 });
    budget.recordFailure('k', 'transient');
    expect(budget.waitMs('k')).toBe(1_000);
    t += 1_000;
    expect(budget.eligible('k')).toBe(true);
  });

  it('starts every tile eligible', () => {
    const clock = fakeClock();
    const budget = new TileRetryBudget(clock.now);
    expect(budget.eligible('2/px/0-0')).toBe(true);
    expect(budget.attemptsFor('2/px/0-0')).toBe(0);
  });

  it('makes a transiently-failed tile eligible again once its cooldown elapses', () => {
    const clock = fakeClock();
    const budget = new TileRetryBudget(clock.now);
    budget.recordFailure('k', 'transient');
    expect(budget.eligible('k')).toBe(false);
    clock.advance(999);
    expect(budget.eligible('k')).toBe(false);
    clock.advance(1);
    expect(budget.eligible('k')).toBe(true);
  });

  it('doubles the cooldown on each successive transient failure', () => {
    const clock = fakeClock();
    const budget = new TileRetryBudget(clock.now);
    budget.recordFailure('k', 'transient');
    clock.advance(1_000);
    budget.recordFailure('k', 'transient');
    clock.advance(1_000);
    expect(budget.eligible('k')).toBe(false); // second cooldown is 2s, not 1s
    clock.advance(1_000);
    expect(budget.eligible('k')).toBe(true);
  });

  it('stops retrying once the attempt cap is spent', () => {
    const clock = fakeClock();
    const budget = new TileRetryBudget(clock.now);
    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
      budget.recordFailure('k', 'transient');
      clock.advance(60_000);
    }
    expect(budget.attemptsFor('k')).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(budget.eligible('k')).toBe(false);
  });

  it('honours an overridden cap and base delay', () => {
    const clock = fakeClock();
    const budget = new TileRetryBudget(clock.now, { maxAttempts: 1, baseDelayMs: 10 });
    budget.recordFailure('k', 'transient');
    clock.advance(10_000);
    expect(budget.eligible('k')).toBe(false);
  });

  it('never retries a permanent failure, however long it waits', () => {
    const clock = fakeClock();
    const budget = new TileRetryBudget(clock.now);
    budget.recordFailure('k', 'permanent');
    clock.advance(24 * 60 * 60 * 1_000);
    expect(budget.eligible('k')).toBe(false);
    expect(budget.attemptsFor('k')).toBe(0);
  });

  it('forgets a tile that eventually loaded', () => {
    const clock = fakeClock();
    const budget = new TileRetryBudget(clock.now);
    budget.recordFailure('k', 'transient');
    budget.recordSuccess('k');
    expect(budget.eligible('k')).toBe(true);
    expect(budget.attemptsFor('k')).toBe(0);
  });

  it('clear() drops both transient and permanent history', () => {
    const clock = fakeClock();
    const budget = new TileRetryBudget(clock.now);
    budget.recordFailure('a', 'transient');
    budget.recordFailure('b', 'permanent');
    budget.clear();
    expect(budget.eligible('a')).toBe(true);
    expect(budget.eligible('b')).toBe(true);
  });

  describe('waitMs', () => {
    it('is 0 for a tile that has never failed', () => {
      const budget = new TileRetryBudget(fakeClock().now);
      expect(budget.waitMs('k')).toBe(0);
    });

    it('counts down the cooldown, then reaches 0', () => {
      const clock = fakeClock();
      const budget = new TileRetryBudget(clock.now, { baseDelayMs: 1_000 });
      budget.recordFailure('k', 'transient');
      expect(budget.waitMs('k')).toBe(1_000);
      clock.advance(400);
      expect(budget.waitMs('k')).toBe(600);
      clock.advance(600);
      expect(budget.waitMs('k')).toBe(0);
    });

    it('is Infinity for a permanent failure — there is nothing to wait for', () => {
      const budget = new TileRetryBudget(fakeClock().now);
      budget.recordFailure('k', 'permanent');
      expect(budget.waitMs('k')).toBe(Infinity);
    });

    it('is Infinity once the attempt cap is spent', () => {
      const clock = fakeClock();
      const budget = new TileRetryBudget(clock.now);
      for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
        budget.recordFailure('k', 'transient');
        clock.advance(60_000);
      }
      expect(budget.eligible('k')).toBe(false);
      expect(budget.waitMs('k')).toBe(Infinity);
    });

    it('agrees with eligible() at every step', () => {
      const clock = fakeClock();
      const budget = new TileRetryBudget(clock.now, { baseDelayMs: 1_000 });
      budget.recordFailure('k', 'transient');
      for (const step of [0, 500, 400, 100, 1_000]) {
        clock.advance(step);
        expect(budget.eligible('k')).toBe(budget.waitMs('k') === 0);
      }
    });
  });
});
