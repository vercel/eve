import { defineEval, type EveEvalTargetHandle } from "eve/evals";
import { satisfies } from "eve/evals/expect";

interface MessageResponse {
  readonly ok: boolean;
  readonly sessionId?: string;
}

interface ResetResponse {
  readonly acknowledgement?: string;
  readonly previousSessionId?: string;
  readonly status?: "no_active_session" | "reset";
}

interface OwnerResponse {
  readonly sessionId: string | null;
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
 * Reset a parked continuation-addressed conversation from a custom channel.
 *
 * The reset route does not call `send`: after its fixed acknowledgement the
 * token has no owner. The next ordinary message claims the same thread token
 * for a different workflow session.
 */
export default defineEval({
  description: "Reset a custom-channel session without creating a model turn for /new.",
  timeoutMs: 240_000,

  async test(t) {
    const threadId = crypto.randomUUID();
    const initial = await postJson<MessageResponse>(t.target, `/threads/${threadId}/messages`, {
      message: "Reply with exactly RESET-INITIAL-OK.",
    });
    await t.require(
      initial,
      satisfies(
        (value: MessageResponse) => value.ok === true && typeof value.sessionId === "string",
        "the initial message starts a session",
      ),
    );
    const previousSessionId = initial.sessionId!;

    const initialTurn = await t.target.watchTurn(previousSessionId).result();
    initialTurn.notEvent("turn.failed");
    initialTurn.notEvent("session.failed");
    initialTurn.messageIncludes(/RESET-INITIAL-OK/i);

    const reset = await postJson<ResetResponse>(t.target, `/threads/${threadId}/new`, {});
    await t.require(
      reset,
      satisfies(
        (value: ResetResponse) =>
          value.status === "reset" &&
          value.previousSessionId === previousSessionId &&
          value.acknowledgement === "Started a new conversation.",
        "the route retires the observed session and returns its fixed acknowledgement",
      ),
    );

    const afterReset = await postJson<OwnerResponse>(t.target, `/threads/${threadId}/owner`, {});
    await t.require(
      afterReset,
      satisfies(
        (value: OwnerResponse) => value.sessionId === null,
        "/new does not start a replacement model session",
      ),
    );

    const replacement = await postJson<MessageResponse>(t.target, `/threads/${threadId}/messages`, {
      message: "Reply with exactly RESET-REPLACEMENT-OK.",
    });
    await t.require(
      replacement,
      satisfies(
        (value: MessageResponse) =>
          value.ok === true &&
          typeof value.sessionId === "string" &&
          value.sessionId !== previousSessionId,
        "the same thread token starts a fresh session after reset",
      ),
    );

    const replacementTurn = await t.target.watchTurn(replacement.sessionId!).result();
    replacementTurn.notEvent("turn.failed");
    replacementTurn.notEvent("session.failed");
    replacementTurn.messageIncludes(/RESET-REPLACEMENT-OK/i);

    t.succeeded();
  },
});
