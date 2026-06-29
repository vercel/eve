import { Buffer } from "node:buffer";

import type {
  JSONSchema7,
  LanguageModelV3CallOptions,
  LanguageModelV3ToolResultOutput,
  SharedV3Warning,
} from "@ai-sdk/provider";

import type { CodexAppServerInput, CodexDynamicTool } from "#public/codex/types.js";

export function mapCodexTools(
  tools: LanguageModelV3CallOptions["tools"],
  toolChoice: LanguageModelV3CallOptions["toolChoice"],
): { readonly tools: readonly CodexDynamicTool[]; readonly warnings: readonly SharedV3Warning[] } {
  const dynamicTools: CodexDynamicTool[] = [];
  const warnings: SharedV3Warning[] = [];
  for (const tool of tools ?? []) {
    if (tool.type !== "function") {
      warnings.push({
        details: "Codex subscription models only bridge AI SDK function tools through eve.",
        feature: `provider tool "${tool.name}"`,
        type: "unsupported",
      });
      continue;
    }
    dynamicTools.push({
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema,
      name: tool.name,
    });
  }
  if (toolChoice?.type === "none") {
    return { tools: [], warnings };
  }
  if (toolChoice?.type === "tool") {
    return {
      tools: dynamicTools.filter((tool) => tool.name === toolChoice.toolName),
      warnings,
    };
  }
  return { tools: dynamicTools, warnings };
}

export function codexOutputSchema(options: LanguageModelV3CallOptions): JSONSchema7 | undefined {
  return options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined;
}

export function renderCodexPrompt(
  prompt: LanguageModelV3CallOptions["prompt"],
  toolChoice: LanguageModelV3CallOptions["toolChoice"],
): readonly CodexAppServerInput[] {
  const transcript = [
    "You are the model for an eve agent.",
    "Continue this durable eve transcript. eve executes the registered function tools itself.",
    "Treat recorded tool results as completed facts. Use a registered eve tool when an action must enter the eve tool loop.",
    toolChoiceInstruction(toolChoice),
    "",
    ...prompt.flatMap((message) => renderMessage(message)),
  ].join("\n\n");
  const images = prompt.flatMap((message) => renderMessageImages(message));
  return [{ text: transcript, type: "text" }, ...images];
}

function toolChoiceInstruction(toolChoice: LanguageModelV3CallOptions["toolChoice"]): string {
  switch (toolChoice?.type) {
    case "none":
      return "Do not call a tool in this step.";
    case "required":
      return "Call one available eve tool before answering this step.";
    case "tool":
      return `Use only the eve tool "${toolChoice.toolName}" in this step.`;
    case "auto":
    case undefined:
      return "Choose whether a tool is needed for this step.";
  }
}

export function stringifyCodexJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function renderMessage(message: LanguageModelV3CallOptions["prompt"][number]): readonly string[] {
  switch (message.role) {
    case "system":
      return [`[system]\n${message.content}`];
    case "user":
      return [
        `[user]\n${message.content
          .map((part) => (part.type === "text" ? part.text : formatFileReference(part.mediaType)))
          .join("\n")}`,
      ];
    case "assistant":
      return [
        `[assistant]\n${message.content
          .map((part) => {
            switch (part.type) {
              case "text":
              case "reasoning":
                return part.text;
              case "file":
                return formatFileReference(part.mediaType);
              case "tool-call":
                return `Tool call ${part.toolName} (${part.toolCallId}): ${stringifyCodexJson(part.input)}`;
              case "tool-result":
                return `Tool result ${part.toolName} (${part.toolCallId}): ${formatToolResult(part.output)}`;
            }
          })
          .join("\n")}`,
      ];
    case "tool":
      return [
        `[tool]\n${message.content
          .map((part) => {
            if (part.type === "tool-approval-response") {
              return `Approval ${part.approvalId}: ${part.approved ? "approved" : "denied"}${part.reason ? ` (${part.reason})` : ""}`;
            }
            return `Tool result ${part.toolName} (${part.toolCallId}): ${formatToolResult(part.output)}`;
          })
          .join("\n")}`,
      ];
  }
}

function renderMessageImages(
  message: LanguageModelV3CallOptions["prompt"][number],
): readonly CodexAppServerInput[] {
  if (message.role === "system" || message.role === "tool") {
    return [];
  }
  return message.content.flatMap((part) =>
    part.type === "file"
      ? [{ type: "image" as const, url: toImageDataUrl(part.data, part.mediaType) }]
      : [],
  );
}

function formatFileReference(mediaType: string): string {
  if (!mediaType.startsWith("image/")) {
    throw new Error(`Codex subscription models support image files, not "${mediaType}".`);
  }
  return `[attached ${mediaType} image]`;
}

function toImageDataUrl(data: Uint8Array | URL | string, mediaType: string): string {
  if (!mediaType.startsWith("image/")) {
    throw new Error(`Codex subscription models support image files, not "${mediaType}".`);
  }
  if (data instanceof Uint8Array) {
    return `data:${mediaType};base64,${Buffer.from(data).toString("base64")}`;
  }
  if (data instanceof URL || /^[a-z][a-z\d+.-]*:/iu.test(data)) {
    if (typeof data === "string" && data.startsWith("data:")) {
      return data;
    }
    throw new Error("Codex subscription models require inline image data, not a remote file URL.");
  }
  return `data:${mediaType};base64,${data}`;
}

function formatToolResult(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return stringifyCodexJson(output.value);
    case "execution-denied":
      return output.reason === undefined
        ? "Execution denied."
        : `Execution denied: ${output.reason}`;
    case "content":
      return output.value
        .map((part) => (part.type === "text" ? part.text : `[tool output ${part.type}]`))
        .join("\n");
  }
}
