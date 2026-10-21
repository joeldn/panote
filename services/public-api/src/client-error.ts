import { scrubErrorText, type ClientErrorReport } from '@internal/contracts';

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
    message: scrubErrorText(report.message),
    stack: report.stack.map(scrubErrorText),
    path: scrubErrorText(report.path),
  });
};
