import type { JSONValue } from "ai";

import { z } from "#compiled/zod/index.js";
import { createLogger } from "#internal/logging.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import type { ToolModelOutputPart } from "#shared/tool-definition.js";
import { formatValidationError } from "#runtime/validation.js";
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

const toolModelOutputPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("file"),
    data: z.object({ type: z.literal("data"), data: z.string() }),
    mediaType: z.string().min(1),
    filename: z.string().optional(),
  }),
]);

const toolModelOutputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: z.string() }),
  z.object({ type: z.literal("json"), value: z.unknown() }),
  z.object({ type: z.literal("content"), value: z.array(toolModelOutputPartSchema).min(1) }),
]);

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
      assertSupportedFilePartData(input.output);

      const parsed = toolModelOutputSchema.safeParse(input.output);
      if (!parsed.success) {
        throw new TypeError(formatValidationError(parsed.error));
      }

      const output = parsed.data;
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
        for (const part of output.value) {
          if (part.type === "file") {
            warnOversizedFilePayload(part, input.toolName);
          }
        }
      }
      return output;
    },
  );
}

/**
 * Asserts every file part's `data` is the supported form, covering the two
 * author mistakes the schema cannot explain well: raw bytes (which
 * `JSON.stringify` would corrupt silently at the durable boundary — the
 * #497 failure class), and AI SDK `FileData` tags eve does not support
 * yet. On a `Uint8Array` the schema would report a missing `data.type`
 * key; the real fix is to base64-encode. Everything structural is left to
 * the schema.
 */
function assertSupportedFilePartData(output: unknown): void {
  if (output === null || typeof output !== "object") return;
  const candidate = output as { readonly type?: unknown; readonly value?: unknown };
  if (candidate.type !== "content" || !Array.isArray(candidate.value)) return;

  for (const part of candidate.value) {
    if (part === null || typeof part !== "object") continue;
    const filePart = part as { readonly type?: unknown; readonly data?: unknown };
    if (filePart.type !== "file") continue;

    const data = filePart.data;
    const taggedPayload =
      data !== null && typeof data === "object"
        ? (data as { readonly data?: unknown }).data
        : undefined;
    if (isBinaryPayload(data) || isBinaryPayload(taggedPayload)) {
      throw new TypeError(
        "Expected file content part data to be a base64 string, received raw bytes. " +
          "Base64-encode binary payloads before returning them from toModelOutput.",
      );
    }

    const tag =
      data !== null && typeof data === "object"
        ? (data as { readonly type?: unknown }).type
        : undefined;
    if (typeof tag === "string" && UNSUPPORTED_FILE_DATA_TAGS.has(tag)) {
      throw new TypeError(
        `File content part data tag "${tag}" is not supported yet; ` +
          'only { type: "data" } with a base64 string is accepted.',
      );
    }
  }
}

function warnOversizedFilePayload(
  part: { readonly data: { readonly data: string }; readonly mediaType: string },
  toolName: string,
): void {
  const estimatedBytes = Math.floor((part.data.data.length * 3) / 4);
  if (estimatedBytes <= CONTENT_FILE_WARN_BYTES) return;
  log.warn(
    "content-part file payload exceeds the inline size guideline — it is persisted in " +
      "history and re-sent on every subsequent model call",
    {
      estimatedBytes,
      mediaType: part.mediaType,
      toolName,
      warnBytes: CONTENT_FILE_WARN_BYTES,
    },
  );
}

function isBinaryPayload(value: unknown): value is Uint8Array | ArrayBuffer {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}
