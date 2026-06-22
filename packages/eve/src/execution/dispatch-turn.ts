import { createHook } from "#compiled/@workflow/core/index.js";

import type { HookPayload, SessionCapabilities } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import type { TurnCompletionPayload } from "#execution/turn-workflow.js";
import { rebuildSerializableError } from "#execution/workflow-errors.js";
import { dispatchTurnStep } from "#execution/workflow-steps.js";
import type { RunMode } from "#shared/run-mode.js";

/** Dispatches one child turn workflow and resolves its durable completion hook. */
export async function dispatchAndAwaitTurn(input: {
  readonly cancelToken?: string;
  readonly capabilities?: SessionCapabilities;
  readonly completionToken: string;
  readonly delivery: HookPayload;
  readonly mode: RunMode;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<NextDriverAction> {
  const completion = createHook<TurnCompletionPayload>({ token: input.completionToken });

  try {
    await dispatchTurnStep({
      cancelToken: input.cancelToken,
      capabilities: input.capabilities,
      completionToken: completion.token,
      delivery: input.delivery,
      mode: input.mode,
      parentWritable: input.parentWritable,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    });

    const payload = await awaitHookPayload(completion);
    if (payload.kind === "turn-error") {
      throw rebuildSerializableError(payload.error);
    }
    return payload.action;
  } finally {
    completion.dispose();
  }
}

async function awaitHookPayload<T>(hook: AsyncIterable<T>): Promise<T> {
  for await (const value of hook) {
    return value;
  }
  throw new Error("Turn completion hook closed before delivering a result.");
}
