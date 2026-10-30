import type { JSONValue } from "ai";

import { z } from "#compiled/zod/index.js";
import { createLogger } from "#internal/logging.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import type { ToolModelOutputPart } from "#tools/definition.js";
import { formatValidationError } from "#runtime/validation.js";
import { withToolOutputSerializationError } from "#harness/tool-output-serialization.js";

/**
 * A validated {@link ToolModelOutput} in the AI SDK's expected shape:
 * `json` values are proven JSON-serializable, `content` arrays are
 * mutable, and file URLs are parsed `URL`s so the value is assignable to
 * the SDK's `ToolResultOutput`.
 */
export type ToolModelOutputValue =
  | { readonly type: "json"; readonly value: JSONValue }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "content"; readonly value: ToolModelOutputValuePart[] };

type ToolModelOutputValuePart =
  | Extract<ToolModelOutputPart, { readonly type: "text" }>
  | {
      readonly type: "file";
      readonly data:
        | { readonly type: "data"; readonly data: string }
        | { readonly type: "url"; readonly url: URL };
      readonly mediaType: string;
      readonly filename?: string;
    };

const log = createLogger("harness.tool-model-output");

/**
 * Content-part file payloads above this decoded size warn. Matches the
 * attachment pipeline's inline-image hydration cap: unlike sandbox-ref
 * attachments, a content part is baked into persisted history and
 * re-sent on every subsequent model call, so large payloads compound.
 */
const CONTENT_FILE_WARN_BYTES = 3 * 1024 * 1024;

/** File-data tags the AI SDK accepts but eve does not support yet. */
const UNSUPPORTED_FILE_DATA_TAGS = new Set(["reference", "text"]);

const toolModelOutputPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("file"),
    data: z.discriminatedUnion("type", [
      z.object({ type: z.literal("data"), data: z.string() }),
      z.object({ type: z.literal("url"), url: z.string() }),
    ]),
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
        return {
          type: "content",
          value: output.value.map((part) => normalizeContentPart(part, input.toolName)),
        };
      }
      return output;
    },
  );
}

function normalizeContentPart(
  part: z.infer<typeof toolModelOutputPartSchema>,
  toolName: string,
): ToolModelOutputValuePart {
  if (part.type === "text") return part;
  if (part.data.type === "data") {
    warnOversizedFilePayload(part.data.data, part.mediaType, toolName);
    return { ...part, data: part.data };
  }
  return { ...part, data: { type: "url", url: parseFileUrl(part.data.url) } };
}

/**
 * Only `https:` URLs are accepted: the provider fetches them, and eve's
 * own attachment refs use internal schemes that must never be authored.
 * The error names only the scheme, since presigned URLs carry credentials.
 */
function parseFileUrl(value: string): URL {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (url?.protocol !== "https:") {
    const received = url === undefined ? "a value that is not a URL" : `a ${url.protocol} URL`;
    throw new TypeError(
      `Expected file content part url to be an https: URL, received ${received}.`,
    );
  }
  return url;
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
          'use { type: "data" } with a base64 string or { type: "url" } with an https: URL.',
      );
    }
  }
}

function warnOversizedFilePayload(base64: string, mediaType: string, toolName: string): void {
  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes <= CONTENT_FILE_WARN_BYTES) return;
  log.warn(
    "content-part file payload exceeds the inline size guideline — it is persisted in " +
      "history and re-sent on every subsequent model call",
    {
      estimatedBytes,
      mediaType,
      toolName,
      warnBytes: CONTENT_FILE_WARN_BYTES,
    },
  );
}

function isBinaryPayload(value: unknown): value is Uint8Array | ArrayBuffer {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}
