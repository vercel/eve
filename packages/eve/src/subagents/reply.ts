import type { TaskInboundUpdate } from "#tasks/types.js";
import { createHash } from "node:crypto";
import type { HookPayload } from "#channel/types.js";
import { sendInbox } from "#execution/inbox/send.js";
import type { ReplyTarget } from "#execution/inbox/types.js";
import { dispatchSessionCommandByToken } from "#execution/session/ingress.js";

/** Routes replies to the invocation owner or admits them as durable session input. */
export async function sendSubagentReply(
  target: ReplyTarget,
  payload: HookPayload | TaskInboundUpdate,
): Promise<"delivered" | "gone"> {
  const eventId = createHash("sha256").update(JSON.stringify(payload)).digest("base64url");
  if (target.kind === "inbox") {
    return await sendInbox(target.address, {
      eventId,
      kind: "agent.response",
      requestId: target.requestId,
      payload,
    });
  }
  if (payload.kind === "task-update") throw new Error("Task updates require an invocation inbox.");
  await dispatchSessionCommandByToken(target.token, { kind: "runtime", payload }, eventId);
  return "delivered";
}
