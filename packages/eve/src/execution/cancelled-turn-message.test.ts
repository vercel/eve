import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { AuthKey, SteeredByKey } from "#context/keys.js";
import { createCancelledModelCallBatchResult } from "#execution/cancelled-model-call-batch.js";
import { preserveCancelledTurnMessage } from "#execution/cancelled-turn-message.js";
import { markFrameworkStepInput } from "#harness/messages.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import type { HarnessSession } from "#harness/types.js";

function session(): HarnessSession {
  return {
    compaction: {},
    continuationToken: "http:cancelled-turn-message",
    history: [],
    sessionId: "cancelled-turn-message",
  };
}

describe("preserveCancelledTurnMessage", () => {
  it("preserves the framework kind on a cancelled framework delivery", async () => {
    const result = await preserveCancelledTurnMessage(
      session(),
      markFrameworkStepInput(
        { message: "Continue the interrupted turn." },
        "execution.continuation",
      ),
    );

    expect(result.history).toEqual([
      {
        content: "Continue the interrupted turn.",
        kind: "execution.continuation",
        role: "user",
      },
    ]);
  });

  it("brands a cancelled real user message as user", async () => {
    const result = await preserveCancelledTurnMessage(session(), {
      message: "Cancel this turn.",
    });

    expect(result.history).toEqual([{ content: "Cancel this turn.", kind: "user", role: "user" }]);
  });
});

describe("createCancelledModelCallBatchResult", () => {
  it("preserves and clears SteeredByKey from the interrupted step context", async () => {
    const alice = {
      attributes: {},
      authenticator: "test",
      principalId: "alice",
      principalType: "user" as const,
    };
    const bob = { ...alice, principalId: "bob" };

    const steeredCtx = new ContextContainer();
    enterSessionProjection(steeredCtx, undefined);
    steeredCtx.set(AuthKey, alice);
    steeredCtx.set(SteeredByKey, [bob]);
    const preserved = await createCancelledModelCallBatchResult({
      beforeBatchContext: { [AuthKey.name]: alice },
      checkpoint: undefined,
      ctx: steeredCtx,
      initialSession: session(),
      sandboxIdleTimeoutMs: undefined,
      stepInput: undefined,
    });
    expect(preserved.serializedContext[SteeredByKey.name]).toEqual([bob]);

    const clearedCtx = new ContextContainer();
    enterSessionProjection(clearedCtx, undefined);
    clearedCtx.set(AuthKey, alice);
    const cleared = await createCancelledModelCallBatchResult({
      beforeBatchContext: { [AuthKey.name]: alice, [SteeredByKey.name]: [bob] },
      checkpoint: undefined,
      ctx: clearedCtx,
      initialSession: session(),
      sandboxIdleTimeoutMs: undefined,
      stepInput: undefined,
    });
    expect(SteeredByKey.name in cleared.serializedContext).toBe(false);
  });
});
