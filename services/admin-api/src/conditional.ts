import { PreconditionRequiredError } from '@internal/worker-kit';

/**
 * R2 precondition for a mutating PUT. A missing `If-Match` is rejected with 428
 * rather than silently degrading to create-only (which would make every update
 * after the first fail forever). `If-Match: *` means unconditional overwrite.
 */
export const updateConditional = (ifMatch: string | undefined): R2Conditional | undefined => {
  if (!ifMatch) throw new PreconditionRequiredError();
  return ifMatch === '*' ? undefined : { etagMatches: ifMatch.replace(/"/g, '') };
};
