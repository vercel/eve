import { defineEval, type EveEvalContext, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

const TOOL_NAME = "wait-for-cancellation";

interface CreateSessionResponse {
  readonly ok: boolean;
  readonly sessionId?: string;
}

interface CancelTurnResponse {
  readonly ok: boolean;
  readonly sessionId?: string;
  readonly status?: "cancelling" | "no_active_turn";
}

async function postJson<T>(
  target: EveEvalTargetHandle,
  path: string,
  body?: unknown,
): Promise<{ readonly payload: T; readonly status: number }> {
  const response = await target.fetch(path, {
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    method: "POST",
  });
  const text = await response.text();
  let payload: T;
  try {
    payload = JSON.parse(text) as T;
  } catch {
    throw new Error(`POST ${path} returned non-JSON (${response.status}): ${text}`);
  }
  return { payload, status: response.status };
}

async function waitForToolCall(t: EveEvalContext, sessionId: string): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, t.signal]);

  try {
    const response = await t.target.fetch(
      `/eve/v1/session/${encodeURIComponent(sessionId)}/stream`,
      { method: "GET", signal },
    );
    if (!response.ok || response.body === null) {
      throw new Error(`Stream request failed (${response.status}).`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });

      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const event = JSON.parse(line) as {
          type: string;
          data?: { actions?: readonly { kind?: string; toolName?: string }[] };
        };
        if (
          event.type === "actions.requested" &&
          event.data?.actions?.some(
            (action) => action.kind === "tool-call" && action.toolName === TOOL_NAME,
          ) === true
        ) {
          return;
        }
        if (event.type === "turn.failed" || event.type === "session.failed") {
          throw new Error(`Turn failed before the ${TOOL_NAME} tool was called.`);
        }
        if (event.type === "session.waiting") {
          throw new Error(`Turn settled before the ${TOOL_NAME} tool was called.`);
        }
      }
    }
    throw new Error(`Stream closed before the ${TOOL_NAME} tool was called.`);
  } finally {
    controller.abort();
  }
}

/**
 * Cancel an in-flight turn over the eve HTTP channel.
 *
 * Flow: start a turn that hangs mid-tool, POST
 * `/eve/v1/session/:id/cancel`, and assert the turn settles as
 * `turn.cancelled` followed by `session.waiting` with zero failure
 * events — then prove the session accepts a follow-up message normally
 * and a late duplicate cancel reports the benign `no_active_turn`.
 */
export default defineEval({
  description: "Cancel an in-flight turn over the eve HTTP cancel route.",
  timeoutMs: 240_000,

  async test(t) {
    const created = await postJson<CreateSessionResponse>(t.target, "/eve/v1/session", {
      message: "Please wait for cancellation.",
    });
    await t.require(
      created,
      satisfies(
        (value: typeof created) =>
          value.status === 202 &&
          value.payload.ok === true &&
          typeof value.payload.sessionId === "string",
        "create session returns a session id",
      ),
    );
    const sessionId = created.payload.sessionId!;
    const cancelPath = `/eve/v1/session/${encodeURIComponent(sessionId)}/cancel`;

    await waitForToolCall(t, sessionId);
    t.log(`Tool call observed mid-turn; cancelling session ${sessionId}.`);

    const cancelled = await postJson<CancelTurnResponse>(t.target, cancelPath);
    await t.require(
      cancelled,
      satisfies(
        (value: typeof cancelled) =>
          value.status === 202 &&
          value.payload.ok === true &&
          value.payload.sessionId === sessionId &&
          value.payload.status === "cancelling",
        "cancel route accepts the cancel with status 'cancelling'",
      ),
    );

    // The cancelled turn: turn.cancelled → session.waiting, never a failure.
    // The attach recovers the continuation token from the cancelled turn's
    // `session.waiting` boundary, so the same handle can send follow-ups.
    const session = await t.target.attachSession(sessionId, { startIndex: 0 });
    session.event("turn.cancelled", { count: 1 });
    session.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
    session.notEvent("turn.failed");
    session.notEvent("step.failed");
    session.notEvent("session.failed");

    // The session accepts the next message normally.
    const followUp = await session.send("Reply with exactly CANCELLATION-FOLLOW-UP-OK.");
    followUp.expectOk();
    followUp.notEvent("turn.cancelled");
    followUp.notEvent("turn.failed");
    followUp.notEvent("session.failed");
    followUp.messageIncludes(/CANCELLATION-FOLLOW-UP-OK/i);

    // With the session parked and the settled turn's hook swept, a
    // duplicate cancel is the benign "nothing to cancel" success. The
    // sweep is asynchronous, so poll briefly.
    let lateStatus: CancelTurnResponse["status"];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const late = await postJson<CancelTurnResponse>(t.target, cancelPath);
      lateStatus = late.payload.status;
      if (late.status === 202 && lateStatus === "no_active_turn") break;
      await t.sleep(500);
    }
    await t.require(
      lateStatus,
      satisfies(
        (value: CancelTurnResponse["status"]) => value === "no_active_turn",
        "a late cancel reports no_active_turn",
      ),
    );

    t.event("turn.cancelled", { count: 1 });
  },
});
