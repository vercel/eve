import type { UserContent } from "ai";

import type {
  ActivityObserverConfig,
  SessionCallback,
  SessionCapabilities,
  TaskDeliveryPolicy,
} from "#channel/types.js";
import type { JsonObject } from "#shared/json.js";
import type { RunMode } from "#shared/run-mode.js";

export interface ParsedCreateBody {
  taskDeliveryPolicy?: TaskDeliveryPolicy;
  activityObserver?: ActivityObserverConfig;
  callback?: SessionCallback;
  capabilities?: SessionCapabilities;
  message?: string | UserContent;
  mode?: RunMode;
  context?: readonly string[];
  operationId?: string;
  outputSchema?: JsonObject;
}

/** Enforces the fields that only make sense when creation also starts a turn. */
export function validateMessageFreeCreate(input: {
  readonly activityObserver: ActivityObserverConfig | undefined;
  readonly callback: SessionCallback | undefined;
  readonly hasClientContext: boolean;
  readonly hasMessageField: boolean;
  readonly message: string | UserContent | undefined;
  readonly mode: RunMode | undefined;
  readonly outputSchema: JsonObject | undefined;
}): Response | undefined {
  if (input.hasMessageField && input.message === undefined) {
    return Response.json(
      { error: "Expected 'message' to be non-empty when provided.", ok: false },
      { status: 400 },
    );
  }
  if (input.message !== undefined) return undefined;
  if (input.mode === "task") {
    return Response.json(
      { error: "Task sessions require a non-empty 'message'.", ok: false },
      { status: 400 },
    );
  }
  if (
    input.hasClientContext ||
    input.callback !== undefined ||
    input.activityObserver !== undefined ||
    input.outputSchema !== undefined
  ) {
    return Response.json(
      {
        error:
          "Creating a session without a message does not accept 'clientContext', 'callback', 'activityObserver', or 'outputSchema'.",
        ok: false,
      },
      { status: 400 },
    );
  }
  return undefined;
}
