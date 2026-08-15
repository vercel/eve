import type { DeliverPayload } from "#channel/types.js";
import type { AuthorizationResult, PendingAuthorizationState } from "#harness/authorization.js";
import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
import type { AuthorizationCallback } from "#runtime/connections/types.js";

export interface MatchedAuthorizationCallback {
  readonly authorization: ConnectionAuthorizationChallenge;
  readonly result: { readonly name: string } & AuthorizationResult;
}

/** Matches current callbacks by attempt ID and legacy callbacks only to legacy state. */
export function matchAuthorizationCallbacks(
  pending: PendingAuthorizationState,
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
          legacy?: true;
        }
      | undefined;
    if (callback === undefined) {
      remainingPayloads.push(payload);
      continue;
    }

    const challenge = pending.challenges.find((candidate) => {
      if (candidate.name !== callback.connectionName) return false;
      return callback.legacy === true
        ? candidate.attemptId === undefined
        : candidate.attemptId === callback.attemptId;
    });
    const attemptKey = challenge?.attemptId ?? challenge?.name;
    if (
      challenge === undefined ||
      attemptKey === undefined ||
      (challenge.principal === undefined && callback.legacy !== true) ||
      matchedAttemptKeys.has(attemptKey)
    ) {
      continue;
    }

    matchedAttemptKeys.add(attemptKey);
    matches.push({
      authorization: challenge.challenge,
      result: {
        attemptId: challenge.attemptId,
        callback: callback.callback,
        hookUrl: challenge.hookUrl,
        name: challenge.name,
        principal: challenge.principal,
        resume: challenge.resume,
      },
    });
  }

  return { matches, remainingPayloads };
}
