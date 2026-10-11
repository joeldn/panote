import { describe, it, expect, vi, afterEach } from 'vitest';
import { Emitter } from './emitter.js';

type Events = { ready: void; progress: number };

describe('Emitter', () => {
  it('calls listeners with the payload', () => {
    const e = new Emitter<Events>();
    const fn = vi.fn();
    e.on('progress', fn);
    e.emit('progress', 0.5);
    expect(fn).toHaveBeenCalledWith(0.5);
  });

  it('stops calling a listener after off()', () => {
    const e = new Emitter<Events>();
    const fn = vi.fn();
    e.on('ready', fn);
    e.off('ready', fn);
    e.emit('ready', undefined);
    expect(fn).not.toHaveBeenCalled();
  });

  describe('a listener that throws', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('is reported, and the listeners after it still run', () => {
      const reportError = vi.fn();
      vi.stubGlobal('reportError', reportError);
      const e = new Emitter<Events>();
      const boom = new Error('boom');
      const after = vi.fn();
      e.on('progress', () => {
        throw boom;
      });
      e.on('progress', after);
      expect(() => e.emit('progress', 1)).not.toThrow();
      expect(after).toHaveBeenCalledWith(1);
      expect(reportError).toHaveBeenCalledExactlyOnceWith(boom);
    });

    it('goes to console.error where reportError does not exist', () => {
      vi.stubGlobal('reportError', undefined);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const e = new Emitter<Events>();
      e.on('ready', () => {
        throw new Error('boom');
      });
      e.emit('ready', undefined);
      expect(consoleError).toHaveBeenCalledTimes(1);
      consoleError.mockRestore();
    });
  });
});
