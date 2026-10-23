import type { AdminApi } from '@internal/web-kit';
import { useEffect, useState } from 'react';

// Whether the signed-in user may open the operator pages: the server decides (admin-api
// ops-gate.ts), and says so on the account response. Asked once per session's API, so moving
// between operator pages doesn't refetch it; a failure isn't kept, and reads as "no".
const asked = new WeakMap<AdminApi, Promise<boolean>>();

export function isOperator(api: AdminApi): Promise<boolean> {
  let answer = asked.get(api);
  if (!answer) {
    // Through a promise, so an API without the call (a test double) is a "no" too.
    answer = Promise.resolve()
      .then(() => api.getAccount())
      .then(
        (a) => a.operator === true,
        () => {
          asked.delete(api);
          return false;
        },
      );
    asked.set(api, answer);
  }
  return answer;
}

/** `null` until the answer is in. */
export function useIsOperator(api: AdminApi): boolean | null {
  const [operator, setOperator] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void isOperator(api).then((yes) => live && setOperator(yes));
    return () => {
      live = false;
    };
  }, [api]);
  return operator;
}
