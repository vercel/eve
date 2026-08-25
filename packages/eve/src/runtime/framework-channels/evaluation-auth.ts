import type { SessionAuthContext } from "#channel/types.js";
import { resolveEveEvaluationRunId } from "#internal/application/dev-environment.js";
import { timingSafeEqualStrings } from "#internal/nitro/dev-client-address.js";
import { extractBearerToken, type AuthFn } from "#public/channels/auth.js";

/**
 * Authenticates the eval harness as a synthetic user principal.
 *
 * `eve eval` mints a per-run id, exports it to the in-process dev server it
 * boots, and sends it as the session bearer. Matching that bearer here gives
 * eval sessions a real `principalType: "user"` identity, so user-scoped
 * flows — interactive connection authorization, sandbox egress consent —
 * park and resume exactly as they do for a production user instead of
 * failing terminally on the synthetic `local-dev` principal.
 *
 * Being an evaluation server is a property of the process (`eve eval` set
 * the flag and run id before boot), never of the request, and the run id
 * never leaves that process, so no inbound request can mint this principal
 * on an ordinary deployment. A server that `eve eval --url` merely points
 * at carries no run id and skips straight to the next authenticator.
 */
export function evaluationUser(): AuthFn<Request> {
  return (request) => {
    const runId = resolveEveEvaluationRunId();
    if (runId === undefined) return null;
    const token = extractBearerToken(request.headers.get("authorization"));
    if (token === null || !timingSafeEqualStrings(token, runId)) return null;
    return EVALUATION_USER_SESSION_AUTH_CONTEXT;
  };
}

const EVALUATION_USER_SESSION_AUTH_CONTEXT: SessionAuthContext = {
  attributes: {},
  authenticator: "eve-eval",
  principalId: "eval-user",
  principalType: "user",
};
