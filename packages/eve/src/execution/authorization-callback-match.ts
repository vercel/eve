import type { DeliverPayload } from "#channel/types.js";
import type { AuthorizationChallenge, AuthorizationResult } from "#harness/authorization.js";
import type { AuthorizationCallback } from "#shared/connection-types.js";

export interface MatchedAuthorizationCallback {
  readonly challenge: AuthorizationChallenge;
  readonly result: { readonly name: string; readonly attemptId: string } & AuthorizationResult;
}

/** Matches each callback to exactly one pending authorization attempt. */
export function matchAuthorizationCallbacks(
  signIns: readonly AuthorizationChallenge[],
  payloads: readonly DeliverPayload[],
): {
  readonly matches: readonly MatchedAuthorizationCallback[];
  readonly remainingPayloads: readonly DeliverPayload[];
} {
  const matches: MatchedAuthorizationCallback[] = [];
  const remainingPayloads: DeliverPayload[] = [];
  const matchedAttemptKeys = new Set<string>();

  for (const payload of payloads) {
    const callback = payload["authorizationCallback"] as
      | {
          attemptId?: string;
          callback: AuthorizationCallback;
          connectionName: string;
        }
      | undefined;
    if (callback === undefined) {
      remainingPayloads.push(payload);
      continue;
    }

    const challenge = signIns.find((candidate) => {
      if (candidate.name !== callback.connectionName) return false;
      return typeof callback.attemptId === "string" && candidate.attemptId === callback.attemptId;
    });
    const attemptKey = challenge?.attemptId;
    if (
      challenge === undefined ||
      attemptKey === undefined ||
      challenge.principal === undefined ||
      matchedAttemptKeys.has(attemptKey)
    ) {
      continue;
    }

    matchedAttemptKeys.add(attemptKey);
    matches.push({
      challenge,
      result: {
        attemptId: attemptKey,
        callback: callback.callback,
        hookUrl: challenge.hookUrl,
        instanceId: challenge.instanceId,
        name: challenge.name,
        principal: challenge.principal,
        resume: challenge.resume,
      },
    });
  }

  return { matches, remainingPayloads };
}
