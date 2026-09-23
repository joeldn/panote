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

/**
 * Maps anything thrown to a Response. WorkerError -> { error: message } at its
 * status; anything else -> { error: 'internal' } at 500. Always JSON.
 * For Hono-free fetch handlers; Hono apps use errorHandler from
 * @internal/worker-kit/hono.
 *
 * Only the 500 branch logs: a WorkerError is an expected, already-meaningful
 * rejection, but an unrecognised throw otherwise left a bare 500 with
 * nothing in the logs to explain it.
 */
export const toErrorResponse = (err: unknown): Response => {
  if (err instanceof WorkerError)
    return Response.json({ error: err.message }, { status: err.status });
  console.error('internal error:', err instanceof Error ? err.message : err);
  return Response.json({ error: 'internal' }, { status: 500 });
};
