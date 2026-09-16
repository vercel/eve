import type { TurnPolicy } from "eve/channels";
import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const TOOL_NAME = "complete-work";

interface MessageResponse {
  readonly ok: boolean;
  readonly sessionId?: string;
}

async function postMessage(
  target: EveEvalTargetHandle,
  threadId: string,
  message: string,
  turnPolicy?: TurnPolicy,
): Promise<MessageResponse> {
  const path = `/threads/${threadId}/messages`;
  const response = await target.fetch(path, {
    body: JSON.stringify({ message, turnPolicy }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${path} failed (${response.status}): ${text}`);
  }
  return JSON.parse(text) as MessageResponse;
}

/** Applies an accepted message at a safe boundary within the active turn. */
export default defineEval({
  description: "An accepted channel message steers the active turn without cancelling its work.",
  timeoutMs: 240_000,

  async test(t) {
    const threadId = crypto.randomUUID();
    const started = await postMessage(t.target, threadId, "Please complete work before answering.");
    await t.require(
      started,
      satisfies(
        (value: MessageResponse) => value.ok === true && typeof value.sessionId === "string",
        "the initial channel message starts a session",
      ),
    );
    const sessionId = started.sessionId!;
    const activeTurn = t.target.watchTurn(sessionId);

    await activeTurn.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some((action) => action.kind === "tool-call" && action.toolName === TOOL_NAME),
      },
    });

    const replacement = await postMessage(
      t.target,
      threadId,
      "Reply with exactly CHANNEL-STEERING-REPLACEMENT-OK.",
      "steer",
    );
    await t.require(
      replacement,
      satisfies(
        (value: MessageResponse) => value.sessionId === sessionId,
        "the replacement remains in the same durable session",
      ),
    );

    const replacementTurn = await activeTurn.result();
    replacementTurn.event("turn.started", { count: 1 });
    replacementTurn.event("message.received", { count: 2 });
    replacementTurn.notEvent("turn.cancelled");
    replacementTurn.notEvent("turn.failed");
    replacementTurn.notEvent("session.failed");
    replacementTurn.messageIncludes(/CHANNEL-STEERING-REPLACEMENT-OK/i);

    t.succeeded();
  },
});
