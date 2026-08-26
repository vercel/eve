import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/** Payloads delivered to the private inbox owned by one active turn. */
export type TurnInboxPayload =
  | Exclude<HookPayload, DeliverHookPayload>
  | {
      readonly delivery: DeliverHookPayload;
      readonly kind: "driver-delivery";
      readonly requestId: string;
    };

/** Control payloads emitted from an active turn to its session driver. */
export type TurnControlPayload =
  | {
      readonly action: NextDriverAction;
      readonly bufferedDeliveries?: readonly DeliverHookPayload[];
      readonly kind: "turn-result";
    }
  | { readonly kind: "turn-error"; readonly error: unknown }
  | { readonly continuationToken: string; readonly kind: "turn-continuation-token" }
  | {
      readonly continuationToken: string;
      readonly inboxToken: string;
      readonly kind: "turn-delivery-request";
      readonly requestId: string;
    }
  | { readonly kind: "turn-delivery-accepted"; readonly requestId: string }
  | { readonly kind: "turn-delivery-cancelled"; readonly requestId: string };

/** Sends one lifecycle payload to the session driver's control hook. */
export async function sendTurnControlStep(input: {
  readonly controlToken: string;
  readonly payload: TurnControlPayload;
}): Promise<void> {
  "use step";

  try {
    await resumeHook(input.controlToken, input.payload);
  } catch (error) {
    // Reset and timeout terminally stop the session driver while its child
    // turn may still be unwinding. A final at-least-once control send then
    // has no receiver and is already obsolete.
    if (!HookNotFoundError.is(error)) throw error;
  }
}
