import type { NextDriverAction } from "#execution/next-driver-action.js";
import type { TurnControlPayload } from "#execution/turn-control-protocol.js";
import { isObject } from "#shared/guards.js";

/** Rejects control values a pinned driver cannot safely interpret. */
export function decodeTurnControlPayload(value: unknown): TurnControlPayload {
  if (!isObject(value)) return unsupportedControl(value);

  const payload = value as TurnControlPayload;
  switch (payload.kind) {
    case "turn-error":
    case "turn-continuation-token":
    case "turn-delivery-request":
    case "turn-delivery-accepted":
    case "turn-delivery-cancelled":
      return payload;
    case "turn-result":
      decodeDriverAction(payload.action);
      return payload;
    default: {
      const unsupported: never = payload;
      return unsupportedControl(unsupported);
    }
  }
}

function decodeDriverAction(value: unknown): NextDriverAction {
  if (!isObject(value)) return unsupportedDriverAction(value);

  const action = value as NextDriverAction;
  switch (action.kind) {
    case "done":
    case "park":
    case "dispatch-runtime-actions":
    case "dispatch-workflow-runtime-actions":
      break;
    default: {
      const unsupported: never = action;
      return unsupportedDriverAction(unsupported);
    }
  }

  if (!isObject(action.sessionState) || typeof action.sessionState.version !== "number") {
    throw new Error("Turn result from a newer eve deployment has no versioned session state.");
  }
  if (!isObject(action.serializedContext)) {
    throw new Error("Turn result from a newer eve deployment has no serialized context.");
  }

  return action;
}

function unsupportedControl(value: unknown): never {
  throw new Error(
    `Turn received unsupported control kind ${JSON.stringify(isObject(value) ? value.kind : undefined)} from a newer eve deployment.`,
  );
}

function unsupportedDriverAction(value: unknown): never {
  throw new Error(
    `Turn received unsupported driver action ${JSON.stringify(isObject(value) ? value.kind : undefined)} from a newer eve deployment.`,
  );
}
