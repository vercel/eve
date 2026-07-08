import type { HookPayload, SessionCapabilities } from "#channel/types.js";
import type { DeliveryBuffers } from "#execution/delivery-buffers.js";
import { TurnControlReceiver } from "#execution/turn-control-receiver.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import type { SessionDeliveryHook } from "#execution/session-delivery-hook.js";
import { dispatchTurnStep } from "#execution/workflow-steps.js";
import type { RunMode } from "#shared/run-mode.js";

/** Dispatches one turn and services its private-inbox control protocol until it terminates. */
export async function dispatchAndAwaitTurn(input: {
  readonly capabilities?: SessionCapabilities;
  readonly controlToken: string;
  readonly deliveryBuffers: DeliveryBuffers;
  readonly delivery: HookPayload;
  readonly deliveryHook: SessionDeliveryHook;
  readonly mode: RunMode;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<NextDriverAction> {
  const control = new TurnControlReceiver({
    deliveryBuffers: input.deliveryBuffers,
    deliveryHook: input.deliveryHook,
    token: input.controlToken,
  });

  try {
    await dispatchTurnStep({
      capabilities: input.capabilities,
      completionToken: control.token,
      delivery: input.delivery,
      mode: input.mode,
      parentWritable: input.parentWritable,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    });

    return await control.waitForAction();
  } finally {
    await control.dispose();
  }
}
