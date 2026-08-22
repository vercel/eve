import { readTaskInputTargetToken } from "#execution/task-input-capability.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import type { RouteContext } from "#public/definitions/channel.js";
import type { InputResponse } from "#runtime/input/types.js";

export async function handleTaskInputResponseRequest(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const token = ctx.params.token;
  if (typeof token !== "string" || token.length === 0) {
    return Response.json({ error: "Missing task input token.", ok: false }, { status: 400 });
  }
  const targetToken = readTaskInputTargetToken(token);
  if (targetToken === undefined) {
    return Response.json({ error: "Invalid task input token.", ok: false }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
  }
  const inputResponses = readInputResponses(body);
  if (inputResponses === undefined || inputResponses.length === 0) {
    return Response.json(
      { error: "Expected a non-empty inputResponses array.", ok: false },
      { status: 400 },
    );
  }
  // Child inboxes outlive deployments; cross the hook in the durable
  // delivery envelope like every other session-inbox producer.
  try {
    await resumeSessionInbox(targetToken, { kind: "send", payload: { inputResponses } });
  } catch {
    return Response.json(
      { error: "Task input target is not pending.", ok: false },
      { status: 404 },
    );
  }
  return Response.json({ ok: true }, { status: 202 });
}

function readInputResponses(value: unknown): readonly InputResponse[] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const responses = Reflect.get(value, "inputResponses");
  if (!Array.isArray(responses)) return undefined;
  const parsed: InputResponse[] = [];
  for (const response of responses) {
    if (response === null || typeof response !== "object" || Array.isArray(response))
      return undefined;
    const requestId = Reflect.get(response, "requestId");
    const optionId = Reflect.get(response, "optionId");
    const text = Reflect.get(response, "text");
    if (
      typeof requestId !== "string" ||
      (optionId !== undefined && typeof optionId !== "string") ||
      (text !== undefined && typeof text !== "string")
    ) {
      return undefined;
    }
    const item: { optionId?: string; requestId: string; text?: string } = { requestId };
    if (typeof optionId === "string") item.optionId = optionId;
    if (typeof text === "string") item.text = text;
    parsed.push(item);
  }
  return parsed;
}
