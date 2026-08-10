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
 */
export const toErrorResponse = (err: unknown): Response =>
  err instanceof WorkerError
    ? Response.json({ error: err.message }, { status: err.status })
    : Response.json({ error: 'internal' }, { status: 500 });
