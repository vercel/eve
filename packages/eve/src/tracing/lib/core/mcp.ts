import type { Attributes } from "./types.js";
import {
  mcpAttributes,
  mcpSessionAttributes,
  rpcStatusAttributes,
  CONTENT_FIELDS,
} from "./contract.js";
import type { ContentSerializer } from "./model.js";

export interface McpUpdate {
  readonly connectionName?: string;
  readonly method?: string;
  readonly toolName?: string;
  readonly protocolVersion?: string;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly statusCode?: string | number;
}

export interface McpLifecycle {
  update(input: McpUpdate): void;
  error(error?: unknown, type?: string): void;
  arguments(value: unknown): void;
  result(value: unknown): void;
}

export function mcpLifecycle(input: {
  readonly write: (attributes: Attributes) => void;
  readonly error: (error?: unknown, type?: string) => void;
  readonly serializer: ContentSerializer;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}): McpLifecycle {
  return {
    update(update) {
      if (update.connectionName !== undefined && update.method !== undefined)
        input.write(
          mcpAttributes({
            connectionName: update.connectionName,
            method: update.method,
            toolName: update.toolName,
            protocolVersion: update.protocolVersion,
            requestId: update.requestId,
          }),
        );
      if (update.sessionId !== undefined) input.write(mcpSessionAttributes(update.sessionId));
      if (update.statusCode !== undefined) input.write(rpcStatusAttributes(update.statusCode));
    },
    error(error, type) {
      input.error(
        input.recordOutputs ? error : undefined,
        type ?? (error instanceof Error ? error.name : undefined),
      );
    },
    arguments(value) {
      if (input.recordInputs)
        input.write({ [CONTENT_FIELDS.toolArguments]: input.serializer.json(value) });
    },
    result(value) {
      if (input.recordOutputs)
        input.write({ [CONTENT_FIELDS.toolResult]: input.serializer.json(value) });
    },
  };
}
