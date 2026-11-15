import { deliverToHostedHook } from "#execution/hosts.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import { resumeRunnableHook } from "#execution/session-inbox/owner.js";

/**
 * Delivers an authorization callback to the hook its URL names: a session's inbox, or a workflow
 * tool run's sign-in hook. The callback route admits no other token, so a URL a session-driver
 * release minted, which named that driver's own hook, never reaches here.
 */
export async function resumeAuthorizationCallback(
  token: string,
  payload: AuthorizationCallbackPayload,
): Promise<void> {
  // A session a host runs in this process holds its hook here, not in Workflow. One a route
  // held once is gone (`HookNotFoundError`).
  if (await deliverToHostedHook(token, payload)) return;
  await resumeRunnableHook(token, payload);
}

export async function handleExpiredLegacyAuthorization(): Promise<Response> {
  return Response.json(
    {
      ok: false,
      error: "This authorization link predates the session upgrade. Request authorization again.",
    },
    { status: 410 },
  );
}
