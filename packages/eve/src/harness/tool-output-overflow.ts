import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { JSONValue, ModelMessage } from "ai";
import type { SandboxSession } from "#public/definitions/sandbox.js";

import type { SandboxAccess } from "#sandbox/state.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { AgentToolOutputDefinition } from "#shared/agent-definition.js";

export const TOOL_OUTPUT_FILES_ROOT = "/workspace/.eve/tool-results";
export const TOOL_OUTPUT_FILE_REFERENCE_KIND = "eve-tool-output-file";
const TOOL_OUTPUT_FILE_REFERENCE_PATH =
  /^\/workspace\/\.eve\/tool-results\/[a-f0-9]{64}\.(?:json|txt)$/;

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

export interface ToolOutputSpill {
  readonly bytes: number;
  readonly callId: string;
  readonly maxInlineBytes: number;
  readonly path: string;
  readonly spillId: string;
  readonly toolName: string;
}

type SerializedToolOutput =
  | {
      readonly bytes: number;
      readonly content: string;
      readonly extension: "txt";
    }
  | {
      readonly bytes: number;
      readonly compact: string;
      readonly extension: "json";
      readonly value: unknown;
    };

/**
 * Replaces oversized model-facing tool results with durable sandbox file references.
 * Framework control results remain inline because later steps reconstruct state from them.
 */
export async function projectOversizedToolResults(input: {
  readonly messages: readonly ModelMessage[];
  readonly policy: AgentToolOutputDefinition | undefined;
  readonly sandboxAccess: SandboxAccess | undefined;
  readonly onSpill?: (spill: ToolOutputSpill) => void | PromiseLike<void>;
}): Promise<readonly ModelMessage[]> {
  if (input.policy === undefined) {
    return input.messages;
  }

  let sandbox: SandboxSession | undefined;
  let changed = false;
  const projected: ModelMessage[] = [];

  for (const message of input.messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      projected.push(message);
      continue;
    }

    let messageChanged = false;
    const content: ToolResponsePart[] = [];
    for (const part of message.content) {
      if (
        part.type !== "tool-result" ||
        part.toolName === "connection_search" ||
        (typeof part.output === "object" &&
          part.output !== null &&
          "type" in part.output &&
          part.output.type === "execution-denied") ||
        isToolOutputFileReference(part.output)
      ) {
        content.push(part);
        continue;
      }

      const serialized = serializeToolOutput(part.output);
      if (serialized === null || serialized.bytes <= input.policy.maxInlineBytes) {
        content.push(part);
        continue;
      }

      if (sandbox === undefined) {
        if (input.sandboxAccess === undefined) {
          throw new Error(
            "Agent tool-output overflow is configured, but sandbox access is unavailable for this step.",
          );
        }
        const activeSandbox = await input.sandboxAccess.get();
        if (activeSandbox === null) {
          throw new Error(
            "Agent tool-output overflow is configured, but this session has no active sandbox.",
          );
        }
        sandbox = activeSandbox;
      }

      const digest = createHash("sha256")
        .update(part.toolCallId)
        .update("\0")
        .update(serialized.extension === "txt" ? serialized.content : serialized.compact)
        .digest("hex");
      const authoredPath = `${TOOL_OUTPUT_FILES_ROOT}/${digest}.${serialized.extension}`;
      const fileContent =
        serialized.extension === "txt"
          ? serialized.content
          : (JSON.stringify(serialized.value, null, 2) ?? serialized.compact);
      await sandbox.writeTextFile({ content: fileContent, path: authoredPath });
      const reference = {
        bytes: serialized.bytes,
        kind: TOOL_OUTPUT_FILE_REFERENCE_KIND,
        path: sandbox.resolvePath(authoredPath),
        toolName: part.toolName,
      } satisfies JsonObject;
      await input.onSpill?.({
        bytes: serialized.bytes,
        callId: part.toolCallId,
        maxInlineBytes: input.policy.maxInlineBytes,
        path: reference.path,
        spillId: digest,
        toolName: part.toolName,
      });
      content.push({
        ...part,
        output: {
          type:
            typeof part.output === "object" &&
            part.output !== null &&
            "type" in part.output &&
            (part.output.type === "error-json" || part.output.type === "error-text")
              ? "error-json"
              : "json",
          value: reference,
        },
      });
      changed = true;
      messageChanged = true;
    }

    projected.push(messageChanged ? { ...message, content } : message);
  }

  return changed ? projected : input.messages;
}

/** Projects one task-delivered value through the agent's tool-output policy. */
export async function projectOversizedToolOutputValue(input: {
  readonly output: JsonValue;
  readonly policy: AgentToolOutputDefinition | undefined;
  readonly sandboxAccess: SandboxAccess | undefined;
  readonly taskId: string;
  readonly onSpill?: (spill: ToolOutputSpill) => void | PromiseLike<void>;
}): Promise<JsonValue> {
  const messages: ModelMessage[] = [
    {
      content: [
        {
          output: { type: "json", value: input.output as JSONValue },
          toolCallId: `task:${input.taskId}`,
          toolName: "task",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
  const projected = await projectOversizedToolResults({
    messages,
    policy: input.policy,
    sandboxAccess: input.sandboxAccess,
    onSpill: input.onSpill,
  });
  const message = projected[0];
  const part = message?.role === "tool" ? message.content[0] : undefined;
  return part?.type === "tool-result" &&
    typeof part.output === "object" &&
    part.output !== null &&
    "value" in part.output
    ? (part.output.value as JsonValue)
    : input.output;
}

function serializeToolOutput(output: ToolResultPart["output"]): SerializedToolOutput | null {
  if (typeof output === "string") {
    return {
      bytes: Buffer.byteLength(output, "utf8"),
      content: output,
      extension: "txt",
    };
  }

  if (typeof output === "object" && output !== null && "type" in output && "value" in output) {
    const type = output.type;
    const value = output.value;
    if ((type === "text" || type === "error-text") && typeof value === "string") {
      return {
        bytes: Buffer.byteLength(value, "utf8"),
        content: value,
        extension: "txt",
      };
    }
    if (type === "json" || type === "error-json") {
      return jsonOutput(value);
    }
  }

  return jsonOutput(output);
}

function jsonOutput(value: unknown): SerializedToolOutput | null {
  const compact = JSON.stringify(value);
  if (compact === undefined) {
    return null;
  }
  return {
    bytes: Buffer.byteLength(compact, "utf8"),
    compact,
    extension: "json",
    value,
  };
}

function isToolOutputFileReference(output: ToolResultPart["output"]): boolean {
  if (
    typeof output !== "object" ||
    output === null ||
    !("type" in output) ||
    !("value" in output)
  ) {
    return false;
  }
  if (
    (output.type !== "json" && output.type !== "error-json") ||
    typeof output.value !== "object" ||
    output.value === null
  ) {
    return false;
  }
  const value = output.value as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  return (
    keys.length === 4 &&
    keys[0] === "bytes" &&
    keys[1] === "kind" &&
    keys[2] === "path" &&
    keys[3] === "toolName" &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    value.kind === TOOL_OUTPUT_FILE_REFERENCE_KIND &&
    typeof value.path === "string" &&
    TOOL_OUTPUT_FILE_REFERENCE_PATH.test(value.path) &&
    typeof value.toolName === "string" &&
    value.toolName.length > 0
  );
}
