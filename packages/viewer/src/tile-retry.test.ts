import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_ATTEMPTS,
  TileFailureMonitor,
  TileHttpError,
  TileRetryBudget,
  classifyFailure,
  classifyStatus,
  isAbortError,
  setSharedTileFailureMonitor,
  sharedTileFailureMonitor,
} from './tile-retry.js';

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
});

describe('TileFailureMonitor', () => {
  function failOnce(
    monitor: TileFailureMonitor,
    pano: string,
    kind: 'transient' | 'permanent' = 'transient',
  ): void {
    const permit = monitor.acquire();
    expect(permit).not.toBeNull();
    monitor.fail(permit!, pano, kind);
  }

  /**
   * Trip the backoff the way it happens for real: several fetches are already
   * in flight (permits taken while healthy) when the outage hits, and they
   * settle as failures against two different panoramas.
   */
  function tripBackoff(monitor: TileFailureMonitor): void {
    const a = monitor.acquire();
    const b = monitor.acquire();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    monitor.fail(a!, 'pano-a', 'transient');
    monitor.fail(b!, 'pano-b', 'transient');
  }

  it('hands out unrestricted permits while healthy', () => {
    const monitor = new TileFailureMonitor({ now: fakeClock().now });
    expect(monitor.canStart()).toBe(true);
    expect(monitor.acquire()?.probe).toBe(false);
    expect(monitor.backingOff()).toBe(false);
  });

  it('does NOT back off when failures stay inside a single panorama', () => {
    const clock = fakeClock();
    const monitor = new TileFailureMonitor({ now: clock.now });
    for (let i = 0; i < 25; i++) {
      failOnce(monitor, 'pano-a');
      clock.advance(100);
    }
    expect(monitor.backingOff()).toBe(false);
    expect(monitor.escalationLevel).toBe(0);
    expect(monitor.canStart()).toBe(true);
  });

  it('backs off once transient failures span two panoramas', () => {
    const clock = fakeClock();
    const monitor = new TileFailureMonitor({ now: clock.now });
    const a = monitor.acquire()!;
    const b = monitor.acquire()!;
    monitor.fail(a, 'pano-a', 'transient');
    expect(monitor.backingOff()).toBe(false); // one panorama is not systemic
    clock.advance(500);
    monitor.fail(b, 'pano-b', 'transient');
    expect(monitor.backingOff()).toBe(true);
    expect(monitor.backoffRemainingMs()).toBe(1_000);
    expect(monitor.canStart()).toBe(false);
    expect(monitor.acquire()).toBeNull();
  });

  it('ignores failures from a panorama that dropped out of the recency window', () => {
    const clock = fakeClock();
    const monitor = new TileFailureMonitor({ now: clock.now, windowMs: 10_000 });
    failOnce(monitor, 'pano-a');
    clock.advance(10_001);
    failOnce(monitor, 'pano-b');
    expect(monitor.backingOff()).toBe(false);
  });

  it('does not count permanent failures as evidence of ill health', () => {
    const clock = fakeClock();
    const monitor = new TileFailureMonitor({ now: clock.now });
    failOnce(monitor, 'pano-a', 'permanent');
    failOnce(monitor, 'pano-b', 'permanent');
    expect(monitor.backingOff()).toBe(false);
    expect(monitor.escalationLevel).toBe(0);
  });

  it('does not count a released (aborted) fetch as a failure', () => {
    const clock = fakeClock();
    const monitor = new TileFailureMonitor({ now: clock.now });
    const a = monitor.acquire()!;
    monitor.release(a);
    monitor.fail(a, 'pano-a', 'transient'); // settled already — must be ignored
    failOnce(monitor, 'pano-b');
    expect(monitor.backingOff()).toBe(false);
  });

  it('releases one probe halfway through the window and suppresses everything else', () => {
    const clock = fakeClock();
    const monitor = new TileFailureMonitor({ now: clock.now });
    tripBackoff(monitor); // 1s window, probe at +500ms

    expect(monitor.acquire()).toBeNull();
    clock.advance(499);
    expect(monitor.acquire()).toBeNull();
    clock.advance(1);
    const probe = monitor.acquire();
    expect(probe?.probe).toBe(true);
    // Only one probe: nothing else gets through while it is in flight.
    expect(monitor.acquire()).toBeNull();
    monitor.release(probe!);
    // ...nor after it settles, since the window's single probe is spent.
    expect(monitor.acquire()).toBeNull();
  });

  it('escalates 1s, 2s, 4s, 8s, 16s and then caps at 30s', () => {
    const clock = fakeClock();
    const monitor = new TileFailureMonitor({ now: clock.now, windowMs: 60_000 });
    const seen: number[] = [];
    for (let trip = 0; trip < 7; trip++) {
      tripBackoff(monitor);
      const delay = monitor.backoffRemainingMs();
      seen.push(delay);
      clock.advance(delay); // wait the window out, then fail again
    }
    expect(seen).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('does not escalate again for failures inside an already-active window', () => {
    const clock = fakeClock();
    const monitor = new TileFailureMonitor({ now: clock.now });
    // Four fetches in flight when the outage hits; the last two settle after
    // the window has already opened and must not push the ladder up again.
    const stragglers = [monitor.acquire()!, monitor.acquire()!];
    tripBackoff(monitor);
    expect(monitor.escalationLevel).toBe(1);
    clock.advance(100);
    monitor.fail(stragglers[0]!, 'pano-a', 'transient');
    monitor.fail(stragglers[1]!, 'pano-b', 'transient');
    expect(monitor.escalationLevel).toBe(1);
    expect(monitor.backoffRemainingMs()).toBe(900);
  });

  it('escalates immediately when the probe itself fails', () => {
    const clock = fakeClock();
    const monitor = new TileFailureMonitor({ now: clock.now });
    tripBackoff(monitor);
    clock.advance(500);
    const probe = monitor.acquire()!;
    monitor.fail(probe, 'pano-a', 'transient');
    expect(monitor.escalationLevel).toBe(2);
    expect(monitor.backoffRemainingMs()).toBe(2_000); // fresh window, next rung
  });

  it('a successful fetch resets the escalation level and clears the backoff', () => {
    const clock = fakeClock();
    const monitor = new TileFailureMonitor({ now: clock.now });
    tripBackoff(monitor); // rung 1: 1s
    clock.advance(1_000);
    tripBackoff(monitor); // rung 2: 2s
    expect(monitor.escalationLevel).toBe(2);

    clock.advance(2_000);
    const permit = monitor.acquire()!;
    monitor.succeed(permit);
    expect(monitor.escalationLevel).toBe(0);
    expect(monitor.backingOff()).toBe(false);

    // ...and the next trip starts again at the bottom rung.
    tripBackoff(monitor);
    expect(monitor.backoffRemainingMs()).toBe(1_000);
  });

  it('a successful probe ends the backoff window early', () => {
    const clock = fakeClock();
    const monitor = new TileFailureMonitor({ now: clock.now });
    tripBackoff(monitor);
    clock.advance(500);
    const probe = monitor.acquire()!;
    expect(probe.probe).toBe(true);
    monitor.succeed(probe);
    expect(monitor.backingOff()).toBe(false);
    expect(monitor.canStart()).toBe(true);
  });

  it('also drops the panorama evidence on success, so one later failure cannot re-trip', () => {
    const clock = fakeClock();
    const monitor = new TileFailureMonitor({ now: clock.now });
    failOnce(monitor, 'pano-a');
    const permit = monitor.acquire()!;
    monitor.succeed(permit);
    failOnce(monitor, 'pano-b');
    expect(monitor.backingOff()).toBe(false);
  });

  it('reset() clears an active backoff', () => {
    const clock = fakeClock();
    const monitor = new TileFailureMonitor({ now: clock.now });
    tripBackoff(monitor);
    expect(monitor.backingOff()).toBe(true);
    monitor.reset();
    expect(monitor.backingOff()).toBe(false);
    expect(monitor.escalationLevel).toBe(0);
  });

  it('runs on Date.now by default', () => {
    const monitor = new TileFailureMonitor();
    const before = Date.now();
    expect(monitor.now()).toBeGreaterThanOrEqual(before);
  });
});

describe('sharedTileFailureMonitor', () => {
  it('returns the same instance across calls — that is what spans panoramas', () => {
    setSharedTileFailureMonitor();
    const first = sharedTileFailureMonitor();
    expect(sharedTileFailureMonitor()).toBe(first);
  });

  it('can be replaced and discarded so tests never inherit backoff state', () => {
    const injected = new TileFailureMonitor({ now: fakeClock().now });
    setSharedTileFailureMonitor(injected);
    expect(sharedTileFailureMonitor()).toBe(injected);
    setSharedTileFailureMonitor();
    expect(sharedTileFailureMonitor()).not.toBe(injected);
  });
});
