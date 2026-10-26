import type { MessageContent } from "#shared/message-content.js";

import type { SessionCallback, SessionCapabilities } from "#channel/types.js";
import type { ClientContextValue } from "#eve-channel/types.js";
import type { JsonObject } from "#shared/json.js";
import type { ToolStub } from "#tool-stubs/types.js";

export interface ParsedCreateBody {
  stubs?: readonly ToolStub[];
  callback?: SessionCallback;
  capabilities?: SessionCapabilities;
  message?: MessageContent;
  context?: ClientContextValue;
  operationId?: string;
  outputSchema?: JsonObject;
  /** Remote agent protocol of a delegating caller; set only with {@link callback}. */
  protocolVersion?: number;
}

/** Enforces the fields that only make sense when creation also starts a turn. */
export function validateMessageFreeCreate(input: {
  readonly callback: SessionCallback | undefined;
  readonly hasClientContext: boolean;
  readonly hasMessageField: boolean;
  readonly message: MessageContent | undefined;
  readonly outputSchema: JsonObject | undefined;
}): Response | undefined {
  if (input.hasMessageField && input.message === undefined) {
    return Response.json(
      { error: "Expected 'message' to be non-empty when provided.", ok: false },
      { status: 400 },
    );
  }
  if (input.message !== undefined) return undefined;
  if (input.hasClientContext || input.callback !== undefined || input.outputSchema !== undefined) {
    return Response.json(
      {
        error:
          "Creating a session without a message does not accept 'clientContext', 'callback', or 'outputSchema'.",
        ok: false,
      },
      { status: 400 },
    );
  }
  return undefined;
}
