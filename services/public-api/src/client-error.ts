import {
  MAX_ERROR_FRAME_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_ERROR_PATH_LENGTH,
  scrubErrorText,
  type ClientErrorReport,
} from '@internal/contracts';

// Capped again after the scrub: masking can lengthen a field (`a@b.co` -> `<email>`).
const scrub = (text: string, max: number): string => scrubErrorText(text).slice(0, max);

/**
 * One structured line per report, which Workers Logs indexes field by field
 * (filter on `event = client-error`). Field by field from the parsed report, and
 * scrubbed again, so a hand-made report can't put a query string or an email in
 * the logs. Nothing about the caller (IP, UA, country) is added.
 */
export const logClientError = (report: ClientErrorReport): void => {
  console.error({
    event: 'client-error',
    app: report.app,
    release: report.release,
    kind: report.kind,
    message: scrub(report.message, MAX_ERROR_MESSAGE_LENGTH),
    stack: report.stack.map((frame) => scrub(frame, MAX_ERROR_FRAME_LENGTH)),
    path: scrub(report.path, MAX_ERROR_PATH_LENGTH),
  });
};
