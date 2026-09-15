import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import type { AuthorizationCallbackPayload } from "#execution/session-inbox/inbox.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { isObject } from "#shared/guards.js";
import { encodeLegacyCommand, resolveLegacyInbox } from "./inbox.js";

export async function resumeAuthorizationCallback(
  token: string,
  payload: AuthorizationCallbackPayload,
): Promise<void> {
  if (sessionInboxHookToken(token) === token) {
    await resumeHook(token, payload);
    return;
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
