import type { JSONValue } from "ai";

import { createLogger } from "#internal/logging.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import type { ToolModelOutputPart } from "#shared/tool-definition.js";
import { withToolOutputSerializationError } from "#harness/tool-output-serialization.js";

/**
 * A validated {@link ToolModelOutput} in the AI SDK's expected shape:
 * `json` values are proven JSON-serializable and `content` arrays are
 * mutable so the value is assignable to the SDK's `ToolResultOutput`.
 */
export type ToolModelOutputValue =
  | { readonly type: "json"; readonly value: JSONValue }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "content"; readonly value: ToolModelOutputPart[] };

const log = createLogger("harness.tool-model-output");

/**
 * Content-part file payloads above this decoded size warn. Matches the
 * attachment pipeline's inline-image hydration cap: unlike sandbox-ref
 * attachments, a content part is baked into persisted history and
 * re-sent on every subsequent model call, so large payloads compound.
 */
const CONTENT_FILE_WARN_BYTES = 3 * 1024 * 1024;

/** File-data tags the AI SDK accepts but eve does not support yet. */
const UNSUPPORTED_FILE_DATA_TAGS = new Set(["url", "reference", "text"]);

/**
 * Validates a tool output as JSON at one of the serialization boundaries,
 * normalizing top-level `undefined` to `null`. Throws
 * `ToolOutputSerializationError` on non-JSON-serializable values.
 */
export function normalizeToolJsonOutput(input: {
  readonly boundary: "execute" | "toModelOutput";
  readonly output: unknown;
  readonly toolCallId?: string;
  readonly toolName: string;
}): JsonValue {
  const candidate = input.output === undefined ? null : input.output;

  return withToolOutputSerializationError(input, () => {
    parseJsonValue(candidate);
    return candidate as JsonValue;
  });
}

/**
 * Single funnel for authored `toModelOutput` results. Validates the
 * eve-owned {@link ToolModelOutput} union and returns it in the AI SDK's
 * expected shape; every rejection throws `ToolOutputSerializationError`
 * at the `toModelOutput` boundary.
 */
export function normalizeToolModelOutput(input: {
  readonly output: unknown;
  readonly toolCallId?: string;
  readonly toolName: string;
}): ToolModelOutputValue {
  return withToolOutputSerializationError(
    {
      boundary: "toModelOutput",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
    },
    () => {
      if (input.output === null || typeof input.output !== "object") {
        throw new TypeError("Expected a tool model output object.");
      }

      const output = input.output as { readonly type?: unknown; readonly value?: unknown };

      if (output.type === "text") {
        if (typeof output.value !== "string") {
          throw new TypeError('Expected text model output to include a string "value".');
        }

        return { type: "text", value: output.value };
      }

      if (output.type === "json") {
        return {
          type: "json",
          value: normalizeToolJsonOutput({
            boundary: "toModelOutput",
            output: output.value,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
          }) as JSONValue,
        };
      }

      if (output.type === "content") {
        if (!Array.isArray(output.value) || output.value.length === 0) {
          throw new TypeError('Expected content model output "value" to be a non-empty array.');
        }

        return {
          type: "content",
          value: output.value.map((part) =>
            normalizeToolModelOutputPart(part, { toolName: input.toolName }),
          ),
        };
      }

      throw new TypeError('Expected tool model output type to be "text", "json", or "content".');
    },
  );
}

function normalizeToolModelOutputPart(
  part: unknown,
  context: { readonly toolName: string },
): ToolModelOutputPart {
  if (part === null || typeof part !== "object") {
    throw new TypeError("Expected each content part to be an object.");
  }

  const candidate = part as {
    readonly type?: unknown;
    readonly text?: unknown;
    readonly data?: unknown;
    readonly mediaType?: unknown;
    readonly filename?: unknown;
  };

  if (candidate.type === "text") {
    if (typeof candidate.text !== "string") {
      throw new TypeError('Expected text content part to include a string "text".');
    }
    return { type: "text", text: candidate.text };
  }

  if (candidate.type === "file") {
    if (typeof candidate.mediaType !== "string" || candidate.mediaType.length === 0) {
      throw new TypeError('Expected file content part to include a non-empty string "mediaType".');
    }
    if (typeof candidate.filename !== "string" && candidate.filename !== undefined) {
      throw new TypeError('Expected file content part "filename" to be a string when present.');
    }

    const payload = normalizeFilePartData(candidate.data);
    const estimatedBytes = Math.floor((payload.length * 3) / 4);
    if (estimatedBytes > CONTENT_FILE_WARN_BYTES) {
      log.warn(
        "content-part file payload exceeds the inline size guideline — it is persisted in " +
          "history and re-sent on every subsequent model call",
        {
          estimatedBytes,
          mediaType: candidate.mediaType,
          toolName: context.toolName,
          warnBytes: CONTENT_FILE_WARN_BYTES,
        },
      );
    }

    const normalized: {
      type: "file";
      data: { type: "data"; data: string };
      mediaType: string;
      filename?: string;
    } = {
      type: "file",
      data: { type: "data", data: payload },
      mediaType: candidate.mediaType,
    };
    if (candidate.filename !== undefined) {
      normalized.filename = candidate.filename;
    }
    return normalized;
  }

  throw new TypeError('Expected content part type to be "text" or "file".');
}

function normalizeFilePartData(data: unknown): string {
  if (isBinaryPayload(data)) {
    throw new TypeError(
      "Expected file content part data to be a base64 string, received raw bytes. " +
        "Base64-encode binary payloads before returning them from toModelOutput.",
    );
  }
  if (data === null || typeof data !== "object") {
    throw new TypeError(
      'Expected file content part "data" to be a tagged object: { type: "data", data: string }.',
    );
  }

  const tagged = data as { readonly type?: unknown; readonly data?: unknown };
  if (tagged.type !== "data") {
    if (typeof tagged.type === "string" && UNSUPPORTED_FILE_DATA_TAGS.has(tagged.type)) {
      throw new TypeError(
        `File content part data tag "${tagged.type}" is not supported yet; ` +
          'only { type: "data" } with a base64 string is accepted.',
      );
    }
    throw new TypeError(
      'Expected file content part "data" to be a tagged object: { type: "data", data: string }.',
    );
  }

  if (isBinaryPayload(tagged.data)) {
    throw new TypeError(
      "Expected file content part data to be a base64 string, received raw bytes. " +
        "Base64-encode binary payloads before returning them from toModelOutput.",
    );
  }
  if (typeof tagged.data !== "string") {
    throw new TypeError("Expected file content part data payload to be a base64 string.");
  }
  return tagged.data;
}

function isBinaryPayload(value: unknown): value is Uint8Array | ArrayBuffer {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}
