import { report } from './report.js';

export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn as (payload: never) => void);
  }

  off<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): void {
    this.listeners.get(type)?.delete(fn as (payload: never) => void);
  }

  /**
   * Call every listener for `type`. One that throws is reported and does not
   * stop the others, nor unwind the caller: an event is a notification, and
   * a host's bug must not break the viewer's own bookkeeping.
   */
  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    this.listeners.get(type)?.forEach((fn) => {
      try {
        (fn as (p: Events[K]) => void)(payload);
      } catch (err) {
        report(err);
      }
    });
  }
}
