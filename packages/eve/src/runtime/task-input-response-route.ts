import { sendCommandToDelivery } from "#execution/session-command-wire.js";
import { readTaskInputTargetToken } from "#execution/task-input-capability.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { InputResponse } from "#runtime/input/types.js";

/** Delivers one authenticated response batch through its scoped child capability. */
export async function handleTaskInputResponseRequest(input: {
  readonly auth: SessionAuthContext | null;
  readonly inputResponses: readonly InputResponse[];
  readonly token: string | undefined;
}): Promise<Response> {
  const token = input.token;
  if (typeof token !== "string" || token.length === 0) {
    return Response.json({ error: "Missing task input token.", ok: false }, { status: 400 });
  }
  const targetToken = readTaskInputTargetToken(token);
  if (targetToken === undefined) {
    return Response.json({ error: "Invalid task input token.", ok: false }, { status: 403 });
  }
  // Child inboxes outlive deployments; cross the hook in the durable
  // delivery envelope like every other session-inbox producer.
  const command = sendCommandToDelivery({
    auth: input.auth,
    kind: "send",
    payload: { inputResponses: input.inputResponses },
  });
  try {
    await resumeHook(targetToken, command);
  } catch {
    return Response.json(
      { error: "Task input target is not pending.", ok: false },
      { status: 404 },
    );
  }
  return Response.json({ ok: true }, { status: 202 });
}
