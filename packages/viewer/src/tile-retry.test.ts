import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  TileFailureMonitor,
  TileHttpError,
  TileRetryBudget,
  classifyFailure,
  classifyStatus,
  isAbortError,
  monotonicClock,
  setSharedTileFailureMonitor,
  sharedTileFailureMonitor,
  type TileFetchPermit,
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

  describe('the probe belongs to the window that issued it', () => {
    /**
     * Open window 1, take its probe, let the window expire, then open window 2
     * — leaving window 1's probe outstanding across the boundary. Returns the
     * stale permit; window 2 is rung 2, runs [1000, 3000) and probes at 2000.
     */
    function probeOutlivingItsWindow(
      monitor: TileFailureMonitor,
      clock: { advance: (ms: number) => void },
    ): TileFetchPermit {
      tripBackoff(monitor); // window 1: [0, 1000), probe at 500
      clock.advance(500);
      const stale = monitor.acquire()!;
      expect(stale.probe).toBe(true);
      clock.advance(500); // window 1 expires with its probe still in flight
      tripBackoff(monitor); // window 2 opens and issues a probe of its own
      expect(monitor.escalationLevel).toBe(2);
      expect(monitor.backoffRemainingMs()).toBe(2_000);
      return stale;
    }

    it('does not escalate on a stale probe failure — that is one-window-old evidence', () => {
      const clock = fakeClock();
      const monitor = new TileFailureMonitor({ now: clock.now, windowMs: 60_000 });
      const stale = probeOutlivingItsWindow(monitor, clock);

      monitor.fail(stale, 'pano-a', 'transient');

      // The forced escalation a failed probe triggers is only earned by the
      // probe of the *current* window: this one proves nothing that the window
      // it belongs to has not already been judged on.
      expect(monitor.escalationLevel).toBe(2);
      expect(monitor.backoffRemainingMs()).toBe(2_000);
    });

    it('does not clear a live window on a stale probe success', () => {
      const clock = fakeClock();
      const monitor = new TileFailureMonitor({ now: clock.now, windowMs: 60_000 });
      const stale = probeOutlivingItsWindow(monitor, clock);

      monitor.succeed(stale);

      // Handing the origin the full request rate back because a request issued
      // a window ago finally came in is exactly the wrong reaction.
      expect(monitor.backingOff()).toBe(true);
      expect(monitor.escalationLevel).toBe(2);
      expect(monitor.acquire()).toBeNull();
    });

    it('still gives the current window its own probe, which works as documented', () => {
      const clock = fakeClock();
      const monitor = new TileFailureMonitor({ now: clock.now, windowMs: 60_000 });
      const stale = probeOutlivingItsWindow(monitor, clock);
      monitor.fail(stale, 'pano-a', 'transient'); // ignored, and consumes nothing

      clock.advance(1_000); // t = 2000: window 2's halfway mark
      const current = monitor.acquire();
      expect(current?.probe).toBe(true);
      // Exactly one, and it is the live window's: recovery is still noticed at
      // the halfway mark rather than at the end of the window.
      expect(monitor.acquire()).toBeNull();
      monitor.succeed(current!);
      expect(monitor.backingOff()).toBe(false);
      expect(monitor.escalationLevel).toBe(0);
    });
  });

  describe('clock', () => {
    it('runs on a monotonic clock by default, not on the wall clock', () => {
      const monitor = new TileFailureMonitor();
      // performance.now() counts from process start, so it is far below the
      // epoch milliseconds Date.now() reports — proof this is not the wall clock.
      expect(monitor.now()).toBeLessThan(Date.now());
      const first = monitor.now();
      expect(monitor.now()).toBeGreaterThanOrEqual(first);
    });

    it('is unaffected by the wall clock being corrected backwards', () => {
      const monitor = new TileFailureMonitor();
      const a = monitor.acquire()!;
      const b = monitor.acquire()!;
      monitor.fail(a, 'pano-a', 'transient');
      monitor.fail(b, 'pano-b', 'transient');
      expect(monitor.backingOff()).toBe(true);

      // An NTP step, a DST bug, or the user setting the system clock back an
      // hour. On Date.now() this left the backoff (and, since the per-tile
      // budget shares this clock, every tile cooldown with it) suppressing
      // fetches for the next 3,600 seconds.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 3_600_000);

      expect(monitor.backoffRemainingMs()).toBeLessThanOrEqual(DEFAULT_BACKOFF_BASE_MS);
    });

    it('falls back to the wall clock where performance.now is unavailable', () => {
      vi.stubGlobal('performance', undefined);
      expect(monotonicClock()).toBe(Date.now);
    });
  });

  describe('acquireExempt', () => {
    it('hands out a permit even while the backoff is suppressing everything else', () => {
      const clock = fakeClock();
      const monitor = new TileFailureMonitor({ now: clock.now });
      tripBackoff(monitor);
      expect(monitor.acquire()).toBeNull();
      expect(monitor.acquireExempt()).not.toBeNull();
    });

    it('is not the recovery probe and does not consume it', () => {
      const clock = fakeClock();
      const monitor = new TileFailureMonitor({ now: clock.now });
      tripBackoff(monitor);
      const exempt = monitor.acquireExempt();
      expect(exempt.probe).toBe(false);
      monitor.fail(exempt, 'pano-c', 'transient');

      // The probe is still there to be taken at the halfway mark — an exempt
      // base fetch neither used it nor forced the ladder up as a failed probe
      // would have.
      expect(monitor.escalationLevel).toBe(1);
      clock.advance(500);
      expect(monitor.acquire()?.probe).toBe(true);
    });

    it('still reports its outcome: a successful base fetch clears the backoff', () => {
      const clock = fakeClock();
      const monitor = new TileFailureMonitor({ now: clock.now });
      tripBackoff(monitor);
      expect(monitor.backingOff()).toBe(true);
      monitor.succeed(monitor.acquireExempt());
      expect(monitor.backingOff()).toBe(false);
      expect(monitor.escalationLevel).toBe(0);
    });

    it('still feeds cross-panorama detection from a healthy state', () => {
      const clock = fakeClock();
      const monitor = new TileFailureMonitor({ now: clock.now });
      monitor.fail(monitor.acquireExempt(), 'pano-a', 'transient');
      expect(monitor.backingOff()).toBe(false);
      monitor.fail(monitor.acquireExempt(), 'pano-b', 'transient');
      expect(monitor.backingOff()).toBe(true);
      expect(monitor.escalationLevel).toBe(1);
    });
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
