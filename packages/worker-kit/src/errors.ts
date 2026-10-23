import { redactOwner } from '@internal/contracts';

export class WorkerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnauthorizedError extends WorkerError {
  constructor(message = 'unauthorized') {
    super(message, 401);
  }
}

export class PreconditionRequiredError extends WorkerError {
  constructor(message = 'If-Match required for update') {
    super(message, 428);
  }
}

// How deep a cause chain is logged; also stops a cycle (an error that is its own cause).
const MAX_CAUSES = 5;

// A thrown non-Error object is logged as JSON (String() would say only
// `[object Object]`), capped, and redacted with the rest.
const MAX_THROWN_JSON = 2000;
const thrownValue = (e: unknown): string => {
  if (typeof e !== 'object' || e === null) return String(e);
  try {
    return (JSON.stringify(e) ?? String(e)).slice(0, MAX_THROWN_JSON);
  } catch {
    return String(e); // A cycle or a BigInt.
  }
};

const oneError = (e: unknown): string =>
  e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : thrownValue(e);

/**
 * An unexpected error as one log string: its stack (which starts with the message,
 * or name and message without one) and each `cause` under it, with the owner segment
 * of any R2 key masked. An R2 or S3 error names the key, whose owner segment decodes
 * back to the sub, and a wrapper's cause can carry one too.
 */
export const describeError = (err: unknown): string => {
  const parts = [oneError(err)];
  let e = err instanceof Error ? err.cause : undefined;
  for (let depth = 0; e !== undefined && depth < MAX_CAUSES; depth++) {
    parts.push(`caused by: ${oneError(e)}`);
    e = e instanceof Error ? e.cause : undefined;
  }
  return redactOwner(parts.join('\n'));
};

/**
 * Maps anything thrown to a Response. WorkerError -> { error: message } at its
 * status; anything else -> { error: 'internal' } at 500. Always JSON.
 * For Hono-free fetch handlers; Hono apps use errorHandler from
 * @internal/worker-kit/hono.
 *
 * Only the 500 branch logs: a WorkerError is an expected, already-meaningful
 * rejection, but an unrecognised throw otherwise left a bare 500 with
 * nothing in the logs to explain it. It logs describeError's redacted text,
 * like the Hono errorHandler.
 */
export const toErrorResponse = (err: unknown): Response => {
  if (err instanceof WorkerError)
    return Response.json({ error: err.message }, { status: err.status });
  console.error('internal error:', describeError(err));
  return Response.json({ error: 'internal' }, { status: 500 });
};
