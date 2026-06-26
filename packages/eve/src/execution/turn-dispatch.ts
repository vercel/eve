import { createHook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, HookPayload, SessionCapabilities } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { closeHookIterator, disposeHook } from "#execution/hook-ownership.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { serviceTurnDeliveryRequest } from "#execution/turn-delivery-relay.js";
import type { TurnCompletionPayload } from "#execution/turn-workflow.js";
import { rebuildSerializableError } from "#execution/workflow-errors.js";
import { dispatchTurnStep } from "#execution/workflow-steps.js";
import type { RunMode } from "#shared/run-mode.js";

/** Dispatches one turn and services its private-inbox control protocol until it terminates. */
export async function dispatchAndAwaitTurn(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly capabilities?: SessionCapabilities;
  readonly completionToken: string;
  readonly consumeNext: () => void;
  readonly delivery: HookPayload;
  readonly getNextPromise: () => Promise<IteratorResult<HookPayload>>;
  readonly mode: RunMode;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly rekeyHook: (nextToken: string) => Promise<void>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<NextDriverAction> {
  const completion = createHook<TurnCompletionPayload>({ token: input.completionToken });
  const completionIterator = completion[Symbol.asyncIterator]();
  let pendingCompletion: Promise<IteratorResult<TurnCompletionPayload>> | null = null;
  const getCompletionPromise = (): Promise<IteratorResult<TurnCompletionPayload>> => {
    pendingCompletion ??= completionIterator.next();
    return pendingCompletion;
  };
  const consumeCompletion = (): void => {
    pendingCompletion = null;
  };

  try {
    await dispatchTurnStep({
      capabilities: input.capabilities,
      completionToken: completion.token,
      delivery: input.delivery,
      mode: input.mode,
      parentWritable: input.parentWritable,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    });

    while (true) {
      const next = await getCompletionPromise();
      consumeCompletion();
      if (next.done) throw new Error("Turn completion hook closed before delivering a result.");

      const payload = next.value;
      if (payload.kind === "turn-error") throw rebuildSerializableError(payload.error);

      if (payload.kind === "turn-result") {
        if (payload.bufferedDeliveries !== undefined) {
          input.bufferedDeliveries.push(...payload.bufferedDeliveries);
        }
        return payload.action;
      }

      if (payload.kind !== "turn-delivery-request") continue;

      const terminal = await serviceTurnDeliveryRequest({
        bufferedDeliveries: input.bufferedDeliveries,
        consumeCompletion,
        consumeNext: input.consumeNext,
        getCompletionPromise,
        getNextPromise: input.getNextPromise,
        request: payload,
        rekeyHook: input.rekeyHook,
      });
      if (terminal !== undefined) return terminal;
    }
  } finally {
    await closeHookIterator(completionIterator);
    await disposeHook(completion);
  }
}
