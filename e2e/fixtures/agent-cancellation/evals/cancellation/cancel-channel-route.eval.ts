import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const TOOL_NAME = "wait-for-cancellation";

interface MessageResponse {
  readonly ok: boolean;
  readonly sessionId?: string;
}

interface StopResponse {
  readonly status?: "accepted" | "no_active_turn";
}

async function postJson<T>(target: EveEvalTargetHandle, path: string, body: unknown): Promise<T> {
  const response = await target.fetch(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${path} failed (${response.status}): ${text}`);
  }
  return JSON.parse(text) as T;
}

/**
 * Cancel an in-flight turn from a custom channel stop route.
 *
 * Flow: start a thread that hangs mid-tool, stop it through the channel's
 * continuation-addressed `cancel` helper, and assert the turn settles as
 * `turn.cancelled` followed by `session.waiting` with zero failure events.
 * Then prove the same thread resumes the same session normally and that an
 * unknown thread reports the benign `no_active_turn` outcome.
 */
export default defineEval({
  description: "Cancel an in-flight turn from a custom channel stop route.",
  timeoutMs: 240_000,

  async test(t) {
    const threadId = crypto.randomUUID();

    const unknownThread = await postJson<StopResponse>(
      t.target,
      `/threads/${crypto.randomUUID()}/stop`,
      {},
    );
    await t.require(
      unknownThread,
      satisfies(
        (value: StopResponse) => value.status === "no_active_turn",
        "stopping an unknown thread reports no_active_turn",
      ),
    );

    const started = await postJson<MessageResponse>(t.target, `/threads/${threadId}/messages`, {
      message: "Please wait for cancellation.",
    });
    await t.require(
      started,
      satisfies(
        (value: MessageResponse) => value.ok === true && typeof value.sessionId === "string",
        "the message route returns a session id",
      ),
    );
    const sessionId = started.sessionId!;

    const live = t.target.watchTurn(sessionId);
    await live.waitForEvent("actions.requested", {
      data: {
        actions: (actions) =>
          actions.some((action) => action.kind === "tool-call" && action.toolName === TOOL_NAME),
      },
    });
    t.log(`Tool call observed mid-turn; stopping thread ${threadId}.`);

    const stopped = await postJson<StopResponse>(t.target, `/threads/${threadId}/stop`, {});
    await t.require(
      stopped,
      satisfies(
        (value: StopResponse) => value.status === "accepted",
        "the stop request is accepted",
      ),
    );

    const cancelledTurn = await live.result();
    cancelledTurn.event("turn.cancelled", { count: 1 });
    cancelledTurn.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
    cancelledTurn.notEvent("turn.failed");
    cancelledTurn.notEvent("step.failed");
    cancelledTurn.notEvent("session.failed");

    const resumed = await postJson<MessageResponse>(t.target, `/threads/${threadId}/messages`, {
      message: "Reply with exactly CHANNEL-CANCEL-FOLLOW-UP-OK.",
    });
    await t.require(
      resumed,
      satisfies(
        (value: MessageResponse) => value.sessionId === sessionId,
        "the thread resumes the same session",
      ),
    );

    const followUp = await t.target
      .watchTurn(sessionId, { startIndex: cancelledTurn.events.length })
      .result();
    followUp.notEvent("turn.cancelled");
    followUp.notEvent("turn.failed");
    followUp.notEvent("session.failed");
    followUp.messageIncludes(/CHANNEL-CANCEL-FOLLOW-UP-OK/i);

    t.succeeded();
  },
});
