import type { UserContent } from "ai";

import type {
  ActivityObserverConfig,
  SessionCallback,
  SessionCapabilities,
} from "#channel/types.js";
import type { JsonObject } from "#shared/json.js";

export interface ParsedCreateBody {
  activityObserver?: ActivityObserverConfig;
  callback?: SessionCallback;
  capabilities?: SessionCapabilities;
  message?: string | UserContent;
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
  readonly outputSchema: JsonObject | undefined;
}): Response | undefined {
  if (input.hasMessageField && input.message === undefined) {
    return Response.json(
      { error: "Expected 'message' to be non-empty when provided.", ok: false },
      { status: 400 },
    );
  }
  if (input.message !== undefined) return undefined;
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
