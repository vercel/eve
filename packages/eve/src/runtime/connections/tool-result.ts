/**
 * The value a connection tool call returns: what the model receives for the
 * call and what a code mode program receives later.
 *
 * - MCP results return `structuredContent` when present, otherwise their text,
 *   parsed as JSON when the tool declares no output schema. Results with image,
 *   audio, or resource content return their MCP `content` blocks, which
 *   {@link connectionToolModelOutput} turns into file parts.
 * - MCP results with `isError: true` become an error carrying their text.
 * - OpenAPI results pass through as `{ status, statusText, body }`.
 */

import type { ToolModelOutput, ToolModelOutputPart } from "#tools/model-output.js";
import { isObject } from "#shared/guards.js";
import type { ConnectionToolMetadata } from "#shared/connection-types.js";

export type ConnectionToolResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

type McpContentBlock = Record<string, unknown> & { readonly type: string };
type FilePart = Extract<ToolModelOutputPart, { readonly type: "file" }>;

const MCP_CONTENT_TYPES = new Set(["text", "image", "audio", "resource", "resource_link"]);

export function toConnectionToolResult(
  protocol: "mcp" | "openapi",
  tool: ConnectionToolMetadata,
  raw: unknown,
): ConnectionToolResult {
  if (protocol === "openapi" || !isObject(raw)) return { ok: true, value: raw ?? null };

  const blocks = Array.isArray(raw.content) ? raw.content.filter(isMcpContentBlock) : [];
  const text = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");

  if (raw.isError === true) {
    const detail =
      text.length > 0
        ? text
        : raw.structuredContent === undefined
          ? "The tool reported an error."
          : JSON.stringify(raw.structuredContent);
    return { ok: false, error: detail };
  }
  if (blocks.some((block) => block.type !== "text")) return { ok: true, value: blocks };
  if (raw.structuredContent !== undefined) return { ok: true, value: raw.structuredContent };
  if (tool.outputSchema === undefined) return { ok: true, value: parseJsonText(text) };
  return { ok: true, value: text };
}

/**
 * Projects a {@link toConnectionToolResult} value for the model: MCP content
 * blocks become text and file parts, strings stay text, and anything else is
 * JSON.
 */
export function connectionToolModelOutput(output: unknown): ToolModelOutput {
  if (isMcpContentBlockList(output)) {
    return { type: "content", value: output.flatMap(toModelOutputParts) };
  }
  if (typeof output === "string") return { type: "text", value: output };
  return { type: "json", value: output ?? null };
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

function isMcpContentBlock(value: unknown): value is McpContentBlock {
  return isObject(value) && typeof value.type === "string" && MCP_CONTENT_TYPES.has(value.type);
}

function isMcpContentBlockList(value: unknown): value is McpContentBlock[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isMcpContentBlock) &&
    value.some((block) => block.type !== "text")
  );
}

function toModelOutputParts(block: McpContentBlock): ToolModelOutputPart[] {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? [{ type: "text", text: block.text }] : [];
    case "image":
    case "audio":
      return typeof block.data === "string" && typeof block.mimeType === "string"
        ? [fileBlockPart(block.data, block.mimeType)]
        : [];
    case "resource": {
      const resource = isObject(block.resource) ? block.resource : {};
      const uri = typeof resource.uri === "string" ? resource.uri : undefined;
      if (typeof resource.blob === "string") {
        const mediaType =
          typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream";
        return [fileBlockPart(resource.blob, mediaType, uri)];
      }
      return typeof resource.text === "string"
        ? [{ type: "text", text: uri === undefined ? resource.text : `${uri}\n${resource.text}` }]
        : [];
    }
    case "resource_link": {
      const name = typeof block.name === "string" ? block.name : "resource";
      const uri = typeof block.uri === "string" ? block.uri : "";
      return [{ type: "text", text: `Resource link: ${name} ${uri}`.trim() }];
    }
    default:
      return [];
  }
}

function fileBlockPart(data: string, mediaType: string, filename?: string): ToolModelOutputPart {
  const part: { -readonly [K in keyof FilePart]: FilePart[K] } = {
    type: "file",
    data: { type: "data", data },
    mediaType,
  };
  if (filename !== undefined) part.filename = filename;
  return part;
}
