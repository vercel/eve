import { defineEval, type EveEvalContext, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

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
  return { payload: (await response.json()) as T, status: response.status };
}

async function waitForSubagentCall(t: EveEvalContext, sessionId: string): Promise<string> {
  return await readStreamUntil(t, sessionId, (event) => {
    const data = event.data as { childSessionId?: unknown; toolName?: unknown } | undefined;
    return event.type === "subagent.called" &&
      data?.toolName === "sleeper" &&
      typeof data.childSessionId === "string"
      ? data.childSessionId
      : undefined;
  });
}

async function waitForCancellationTool(t: EveEvalContext, sessionId: string): Promise<void> {
  await readStreamUntil(t, sessionId, (event) => {
    const data = event.data as
      | { actions?: readonly { kind?: unknown; toolName?: unknown }[] }
      | undefined;
    return event.type === "actions.requested" &&
      data?.actions?.some(
        (action) => action.kind === "tool-call" && action.toolName === "wait-for-cancellation",
      ) === true
      ? true
      : undefined;
  });
}

async function readStreamUntil<T>(
  t: EveEvalContext,
  sessionId: string,
  select: (event: { readonly data?: unknown; readonly type: string }) => T | undefined,
): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, t.signal]);
  try {
    const response = await t.target.fetch(
      `/eve/v1/session/${encodeURIComponent(sessionId)}/stream`,
      { method: "GET", signal },
    );
    if (!response.ok || response.body === null) {
      throw new Error(`Stream request for ${sessionId} failed (${response.status}).`);
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
        const event = JSON.parse(line) as { readonly data?: unknown; readonly type: string };
        const selected = select(event);
        if (selected !== undefined) return selected;
        if (event.type === "turn.failed" || event.type === "session.failed") {
          throw new Error(`Session ${sessionId} failed before the expected event.`);
        }
      }
    }
    throw new Error(`Stream for ${sessionId} ended before the expected event.`);
  } finally {
    controller.abort();
  }
}

export default defineEval({
  description: "Cancel a parent turn and cascade cancellation to its local sleeper subagent.",
  timeoutMs: 240_000,

  async test(t) {
    const created = await postJson<CreateSessionResponse>(t.target, "/eve/v1/session", {
      message: "Delegate a cancellation wait to the sleeper subagent.",
    });
    await t.require(
      created,
      satisfies(
        (value: typeof created) =>
          value.status === 202 && typeof value.payload.sessionId === "string",
        "create session returns a session id",
      ),
    );
    const sessionId = created.payload.sessionId!;
    const childSessionId = await waitForSubagentCall(t, sessionId);
    await waitForCancellationTool(t, childSessionId);

    const cancelled = await postJson<CancelTurnResponse>(
      t.target,
      `/eve/v1/session/${encodeURIComponent(sessionId)}/cancel`,
    );
    await t.require(
      cancelled,
      satisfies(
        (value: typeof cancelled) => value.status === 202 && value.payload.status === "cancelling",
        "parent cancel route accepts the request",
      ),
    );

    const child = await t.target.attachSession(childSessionId, { startIndex: 0 });
    child.event("turn.cancelled", { count: 1 });
    child.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
    child.notEvent("turn.failed");
    child.notEvent("session.failed");

    const parent = await t.target.attachSession(sessionId, { startIndex: 0 });
    parent.event("turn.cancelled", { count: 1 });
    parent.eventOrder([{ type: "turn.cancelled" }, { type: "session.waiting" }]);
    parent.notEvent("subagent.completed");
    parent.notEvent("turn.failed");
    parent.notEvent("session.failed");

    const followUp = await parent.send("Reply with exactly CANCELLATION-SUBAGENT-FOLLOW-UP-OK.");
    followUp.expectOk();
    followUp.notEvent("turn.cancelled");
    followUp.messageIncludes(/CANCELLATION-SUBAGENT-FOLLOW-UP-OK/i);

    t.event("turn.cancelled", { count: 1 });
  },
});
