import { ClientErrorReportSchema, type ClientErrorReport } from '@internal/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createErrorReporter,
  errorSampleRate,
  installErrorReporter,
  MAX_ERROR_REPORTS_PER_PAGE,
  releaseFromModuleUrl,
  type ErrorReporterOptions,
} from './error-reporter.js';

const V8_STACK = [
  'TypeError: boom',
  '    at render (https://panote.dev/assets/index-BxR2v9Qe.js?v=2:1:100)',
  '    at https://panote.dev/assets/index-BxR2v9Qe.js:1:200',
  '    at async Promise.all (index 0)',
].join('\n');

const setup = (opts: Partial<ErrorReporterOptions> = {}) => {
  const send = vi.fn<(url: string, body: string) => void>();
  const reporter = createErrorReporter({
    app: 'website',
    release: 'BxR2v9Qe',
    baseUrl: '',
    send,
    pathname: () => '/s/my-unlisted-tour/embed',
    ...opts,
  });
  const sent = () => send.mock.calls.map(([, body]) => JSON.parse(body) as ClientErrorReport);
  return { send, reporter, sent };
};

const boom = (message = 'boom', stack = V8_STACK) =>
  Object.assign(new TypeError(message), { stack });

describe('createErrorReporter', () => {
  it('sends a scrubbed, schema-valid report to /api/errors', () => {
    const { send, reporter, sent } = setup({ baseUrl: 'https://panote.dev/' });
    reporter.report('error', boom());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe('https://panote.dev/api/errors');
    const [report] = sent();
    expect(report).toEqual({
      app: 'website',
      release: 'BxR2v9Qe',
      kind: 'error',
      message: 'TypeError: boom',
      stack: [
        'at render (https://panote.dev/assets/index-BxR2v9Qe.js:1:100)',
        'at https://panote.dev/assets/index-BxR2v9Qe.js:1:200',
        'at async Promise.all (index 0)',
      ],
      path: '/s/:slug/embed',
    });
    expect(ClientErrorReportSchema.safeParse(report).success).toBe(true);
  });

  it('reads Firefox and Safari frames and keeps only the top ones', () => {
    const stack = Array.from({ length: 9 }, (_, i) => `f${i}@https://panote.dev/a.js:${i}:1`);
    const { reporter, sent } = setup();
    reporter.report('unhandledrejection', boom('x', stack.join('\n')));
    expect(sent()[0]!.stack).toEqual(stack.slice(0, 5));
  });

  it('caps the message and redacts the path with the app rule', () => {
    const { reporter, sent } = setup({
      app: 'admin',
      pathname: () => '/app/t/tour_123/share/link',
      redactPath: (p) => p.replace(/^\/app\/t\/[^/]+/, '/app/t/:tourId'),
    });
    reporter.report('error', boom('x'.repeat(1000)));
    const [report] = sent();
    expect(report!.message).toHaveLength(300);
    expect(report!.path).toBe('/app/t/:tourId/share/link');
  });

  // Generous bound: the main thread must not stall on a huge error; a regression
  // is seconds, not milliseconds.
  it('reports a ~100k-char message and stack quickly', () => {
    const { reporter, sent } = setup();
    const word = 'a'.repeat(100_000);
    const started = performance.now();
    reporter.report('error', boom(word, `TypeError: ${word}\n    at f (${word}:1:2)`));
    expect(performance.now() - started).toBeLessThan(500);
    expect(sent()[0]!.message).toHaveLength(300);
  });

  it('masks an email and a signed URL in the message', () => {
    const { reporter, sent } = setup();
    reporter.report('error', boom('no user a.b@example.com at https://x.dev/p?sig=secret'));
    expect(sent()[0]!.message).toBe('TypeError: no user <email> at https://x.dev/p');
  });

  it('sends a string rejection as is but never serializes other values', () => {
    const { reporter, sent } = setup();
    reporter.report('unhandledrejection', 'plain reason');
    reporter.report('unhandledrejection', { token: 'secret' });
    reporter.report('unhandledrejection', null);
    expect(sent().map((r) => r.message)).toEqual([
      'plain reason',
      'non-Error object',
      'non-Error null',
    ]);
    expect(JSON.stringify(sent())).not.toContain('secret');
  });

  it('uses the fallback frame when the error has no stack', () => {
    const { reporter, sent } = setup();
    reporter.report('error', 'Uncaught oops', 'https://panote.dev/assets/a.js?x=1:3:4');
    expect(sent()[0]!.stack).toEqual(['https://panote.dev/assets/a.js:3:4']);
  });

  it('dedupes repeats and stops after the per-page cap', () => {
    const { reporter, send } = setup();
    reporter.report('error', boom());
    reporter.report('error', boom());
    expect(send).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) reporter.report('error', boom(`e${i}`));
    expect(send).toHaveBeenCalledTimes(MAX_ERROR_REPORTS_PER_PAGE);
  });

  it('ignores cross-origin script errors, ResizeObserver notices and extension frames', () => {
    const { reporter, send } = setup();
    reporter.report('error', 'Script error.');
    reporter.report('error', 'ResizeObserver loop completed with undelivered notifications.');
    reporter.report('error', boom('x', 'TypeError: x\n    at f (chrome-extension://abc/c.js:1:2)'));
    reporter.report('error', boom('y', 'f@moz-extension://abc/c.js:1:2'));
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws, and drops what it cannot describe', () => {
    const { reporter, send } = setup({
      send: () => {
        throw new Error('beacon broke');
      },
    });
    expect(() => reporter.report('error', boom())).not.toThrow();
    const hostile = {
      get name(): string {
        throw new Error('getter');
      },
    };
    Object.setPrototypeOf(hostile, Error.prototype);
    expect(() => reporter.report('error', hostile)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not report what it sets off itself', () => {
    const { reporter, send } = setup();
    send.mockImplementationOnce(() => reporter.report('error', boom('inner')));
    reporter.report('error', boom('outer'));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('falls back to / for a path the schema would refuse', () => {
    const { reporter, sent } = setup({ pathname: () => 'not a path' });
    reporter.report('error', boom());
    expect(sent()[0]!.path).toBe('/');
  });
});

describe('installErrorReporter', () => {
  const install = (random: number) => {
    const target = new EventTarget();
    const send = vi.fn<(url: string, body: string) => void>();
    const uninstall = installErrorReporter(target, {
      app: 'admin',
      release: 'local',
      baseUrl: '',
      sampleRate: 0.25,
      random: () => random,
      send,
      pathname: () => '/app',
    });
    return { target, send, uninstall };
  };
  const errorEvent = (init: Record<string, unknown>) =>
    Object.assign(new Event('error'), { message: '', filename: '', lineno: 0, colno: 0, ...init });

  it('reports uncaught errors and unhandled rejections', () => {
    const { target, send, uninstall } = install(0.1);
    target.dispatchEvent(errorEvent({ error: boom() }));
    target.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: new Error('nope') }),
    );
    target.dispatchEvent(
      errorEvent({
        error: null,
        message: 'Uncaught x',
        filename: 'https://a/b.js',
        lineno: 1,
        colno: 2,
      }),
    );
    const reports = send.mock.calls.map(([, b]) => JSON.parse(b) as ClientErrorReport);
    expect(reports.map((r) => [r.kind, r.message])).toEqual([
      ['error', 'TypeError: boom'],
      ['unhandledrejection', 'Error: nope'],
      ['error', 'Uncaught x'],
    ]);
    expect(reports[2]!.stack).toEqual(['https://a/b.js:1:2']);
    uninstall();
    target.dispatchEvent(errorEvent({ error: boom('after') }));
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('does nothing on a page load outside the sample', () => {
    const { target, send } = install(0.25);
    target.dispatchEvent(errorEvent({ error: boom() }));
    expect(send).not.toHaveBeenCalled();
  });
});

describe('releaseFromModuleUrl', () => {
  it.each([
    ['https://panote.dev/assets/index-BxR2v9Qe.js', 'BxR2v9Qe'],
    ['https://panote.dev/app/assets/index-a_b-C12d.js', 'a_b-C12d'],
    ['http://localhost:5173/src/main.tsx', 'local'],
    ['not a url', 'local'],
  ])('%s -> %s', (url, release) => {
    expect(releaseFromModuleUrl(url)).toBe(release);
  });
});

describe('errorSampleRate', () => {
  it('samples production only', () => {
    expect(errorSampleRate('production')).toBe(0.25);
    expect(errorSampleRate('dev')).toBe(1);
  });
});
