import {
  ClientErrorReportSchema,
  MAX_ERROR_FRAME_LENGTH,
  MAX_ERROR_FRAMES,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_ERROR_PATH_LENGTH,
  scrubErrorText,
  type ClientErrorApp,
  type ClientErrorKind,
} from '@internal/contracts';

import { sendBeaconOrFetch, type BeaconSend } from './beacon.js';

// Uncaught errors and unhandled rejections, sent to public-api's POST /api/errors
// (docs/deploy.md, Error reporting). No third party, no user or client id, and
// nothing from the URL but its pathname: see ClientErrorReportSchema.

/** Most reports one page load sends, after deduping. */
export const MAX_ERROR_REPORTS_PER_PAGE = 5;

/** Every page load reports off production; a quarter of them in production. */
export const errorSampleRate = (mode: string): number => (mode === 'production' ? 0.25 : 1);

// Vite names the entry chunk `index-<hash>.js`; the hash identifies the build.
const CHUNK_HASH = /-([A-Za-z0-9_-]{6,32})\.js$/;

/** The build's entry chunk hash from the entry module's `import.meta.url`, else `local`. */
export const releaseFromModuleUrl = (url: string): string => {
  try {
    return CHUNK_HASH.exec(new URL(url).pathname)?.[1] ?? 'local';
  } catch {
    return 'local';
  }
};

// Noise no fix of ours would change: cross-origin script errors carry no detail, and
// ResizeObserver's loop notice is benign.
const IGNORED_MESSAGES = [/^Script error\.?$/, /ResizeObserver loop/];
const EXTENSION_FRAME = /\b[a-z-]*extension:\/\//i;
// A stack frame as V8 (`at f (url:1:2)`) or Firefox/Safari (`f@url:1:2`) prints it.
const FRAME = /^at\s|:\d+:\d+\)?$/;

export interface ErrorReporterOptions {
  app: ClientErrorApp;
  /** `releaseFromModuleUrl(import.meta.url)` in the app's entry module. */
  release: string;
  /** API origin without a trailing slash; `''` is same-origin. */
  baseUrl: string;
  /** Turns ids in the pathname into route params, e.g. `/app/t/:tourId`. */
  redactPath?: (pathname: string) => string;
  maxReports?: number;
  send?: BeaconSend;
  pathname?: () => string;
}

export interface ErrorReporter {
  /** Never throws. `frame` stands in for the stack when `error` has none. */
  report(kind: ClientErrorKind, error: unknown, frame?: string): void;
}

// Sliced before scrubbing too, so the scrub's cost is bounded whatever the error
// holds; the slack covers masking that shortens text.
const cap = (text: string, max: number): string =>
  scrubErrorText(text.slice(0, max * 4)).slice(0, max);

const describe = (error: unknown): { message: string; stack: string } => {
  if (error instanceof Error) {
    const message = `${error.name}: ${error.message}`;
    return { message, stack: error.stack ?? '' };
  }
  if (typeof error === 'string') return { message: error, stack: '' };
  // Never serialize an arbitrary rejection value: it could hold anything.
  return { message: `non-Error ${error === null ? 'null' : typeof error}`, stack: '' };
};

const framesOf = (stack: string, message: string): string[] =>
  // V8 starts the stack with the message itself; skip it.
  (stack.startsWith(message) ? stack.slice(message.length) : stack)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => FRAME.test(line))
    .slice(0, MAX_ERROR_FRAMES)
    .map((line) => cap(line, MAX_ERROR_FRAME_LENGTH));

const pathOf = (pathname: string, redact: (p: string) => string): string => {
  const path = cap(redact(pathname), MAX_ERROR_PATH_LENGTH);
  return /^\/[^?#\s]*$/.test(path) ? path : '/';
};

export function createErrorReporter(opts: ErrorReporterOptions): ErrorReporter {
  const send = opts.send ?? sendBeaconOrFetch;
  const pathname = opts.pathname ?? (() => location.pathname);
  const redact = opts.redactPath ?? ((p: string) => p);
  const max = opts.maxReports ?? MAX_ERROR_REPORTS_PER_PAGE;
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/errors`;
  const seen = new Set<string>();
  let busy = false;

  return {
    report(kind, error, frame) {
      // `busy`: anything the reporter itself sets off is never reported.
      if (busy || seen.size >= max) return;
      busy = true;
      try {
        const described = describe(error);
        const message = cap(described.message, MAX_ERROR_MESSAGE_LENGTH);
        const stack = framesOf(described.stack, described.message);
        if (stack.length === 0 && frame) stack.push(cap(frame, MAX_ERROR_FRAME_LENGTH));
        if (IGNORED_MESSAGES.some((re) => re.test(message))) return;
        if (stack[0] !== undefined && EXTENSION_FRAME.test(stack[0])) return;
        const key = `${kind}|${message}|${stack[0] ?? ''}`;
        if (seen.has(key)) return;
        const parsed = ClientErrorReportSchema.safeParse({
          app: opts.app,
          release: opts.release,
          kind,
          message,
          stack,
          path: pathOf(pathname(), redact),
        });
        if (!parsed.success) return;
        seen.add(key);
        send(url, JSON.stringify(parsed.data));
      } catch {
        // Reporting is best effort and must never become an error of its own.
      } finally {
        busy = false;
      }
    },
  };
}

export interface InstallErrorReporterOptions extends ErrorReporterOptions {
  /** Share of page loads that report at all (`errorSampleRate`), decided once. */
  sampleRate: number;
  random?: () => number;
}

/** Listens for uncaught errors and unhandled rejections; returns the uninstaller. */
export function installErrorReporter(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  opts: InstallErrorReporterOptions,
): () => void {
  const random = opts.random ?? Math.random;
  if (!(random() < opts.sampleRate)) return () => {};
  const reporter = createErrorReporter(opts);
  const onError = (event: ErrorEvent) => {
    const at = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined;
    reporter.report('error', event.error ?? event.message, at);
  };
  const onRejection = (event: PromiseRejectionEvent) =>
    reporter.report('unhandledrejection', event.reason);
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
