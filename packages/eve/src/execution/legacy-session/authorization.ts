import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";
import { encodeLegacyCommand, resolveLegacyInbox } from "./inbox.js";

/**
 * Delivers an authorization callback to the hook named in its URL. Current
 * URLs carry a physical hook token (a session inbox or a workflow-tool
 * callback); URLs minted by a pre-cutover driver carry that driver's own
 * logical token, which is re-encoded for it or rejected once imported.
 */
export async function resumeAuthorizationCallback(
  token: string,
  payload: AuthorizationCallbackPayload,
): Promise<void> {
  try {
    await resumeHook(token, payload);
    return;
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
  }
  const target = await resolveLegacyInbox(token);
  if (target.current)
    throw new Error(
      "Authorization was interrupted by the session upgrade. Request authorization again.",
    );
  const metadata = await target.hook.metadata;
  await resumeHook(
    target.hook.token,
    encodeLegacyCommand(
      { kind: "deliver", payloads: payload.payloads },
      isObject(metadata) ? metadata.sessionInboxWireVersion : undefined,
    ),
  );
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
