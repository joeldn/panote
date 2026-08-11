import { describe, it, expect, vi } from 'vitest';
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
});
