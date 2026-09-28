import type { JsonObject } from "#shared/json.js";
import type { ToolModelOutput, ToolModelOutputPart } from "#tools/model-output.js";

/**
 * Projects an MCP `CallToolResult` to what the model sees: its `content`
 * blocks, which the MCP spec defines as the model-facing result. Without
 * this, the model receives the whole envelope as JSON: `_meta`, `isError`,
 * the text again as `structuredContent`, and the text itself JSON-escaped.
 * That envelope stays in history and is re-sent on every later step.
 *
 * `structuredContent` is used only when `content` is empty. Anything that
 * is not a `CallToolResult` passes through unchanged. Channels still
 * receive the full result on `action.result`.
 */
export function mcpToolResultToModelOutput(output: unknown): ToolModelOutput {
  if (!isCallToolResult(output)) return defaultModelOutput(output);

  const parts = output.content.map(contentBlockToPart);
  if (parts.length === 0) {
    return output.structuredContent === undefined
      ? { type: "text", value: output.isError === true ? "Tool call failed." : "" }
      : { type: "json", value: output.structuredContent };
  }
  if (output.isError === true) parts.unshift({ type: "text", text: "Tool call failed:" });
  if (parts.every((part) => part.type === "text")) {
    return { type: "text", value: parts.map((part) => part.text).join("\n") };
  }
  return { type: "content", value: parts };
}

/** Durable-callback form of {@link mcpToolResultToModelOutput}; the closure is unused. */
export function mcpToolResultToModelOutputCallback(
  _closure: JsonObject,
  output: unknown,
): ToolModelOutput {
  return mcpToolResultToModelOutput(output);
}

interface CallToolResult {
  readonly content: readonly ContentBlock[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

type ContentBlock = Readonly<Record<string, unknown>> & { readonly type: string };

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    isRecord(value) &&
    Array.isArray(value.content) &&
    value.content.every((block) => isRecord(block) && typeof block.type === "string") &&
    (value.isError === undefined || typeof value.isError === "boolean")
  );
}

function contentBlockToPart(block: ContentBlock): ToolModelOutputPart {
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (
    (block.type === "image" || block.type === "audio") &&
    typeof block.data === "string" &&
    typeof block.mimeType === "string"
  ) {
    return filePart(block.data, block.mimeType);
  }
  if (block.type === "resource" && isRecord(block.resource)) {
    const { blob, mimeType, text } = block.resource;
    if (typeof text === "string") return { type: "text", text };
    if (typeof blob === "string") {
      return filePart(blob, typeof mimeType === "string" ? mimeType : "application/octet-stream");
    }
  }
  return { type: "text", text: JSON.stringify(block) };
}

function filePart(data: string, mediaType: string): ToolModelOutputPart {
  return { type: "file", data: { type: "data", data }, mediaType };
}

function defaultModelOutput(output: unknown): ToolModelOutput {
  return typeof output === "string"
    ? { type: "text", value: output }
    : { type: "json", value: output ?? null };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
