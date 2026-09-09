import type { TurnPolicy } from "eve/channels";
import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const TOOL_NAME = "wait-for-cancellation";

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

/** Replaces an active turn through the custom channel's explicit interrupt policy. */
export default defineEval({
  description: "An interrupting channel message replaces the active turn.",
  timeoutMs: 240_000,

  async test(t) {
    const threadId = crypto.randomUUID();
    const started = await postMessage(t.target, threadId, "Please wait for cancellation.");
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
      "interrupt",
    );
    await t.require(
      replacement,
      satisfies(
        (value: MessageResponse) => value.sessionId === sessionId,
        "the replacement remains in the same durable session",
      ),
    );

    const cancelled = await activeTurn.result();
    cancelled.event("turn.interrupted", { count: 1 });
    cancelled.eventOrder([
      { type: "turn.interrupted" },
      { type: "turn.started", data: { sequence: 1 } },
      { type: "session.waiting" },
    ]);
    cancelled.notEvent("turn.failed");
    cancelled.notEvent("session.failed");

    const replacementTurn = cancelled;
    replacementTurn.notEvent("turn.cancelled");
    replacementTurn.notEvent("turn.failed");
    replacementTurn.notEvent("session.failed");
    replacementTurn.messageIncludes(/CHANNEL-STEERING-REPLACEMENT-OK/i);

    t.succeeded();
  },
});
